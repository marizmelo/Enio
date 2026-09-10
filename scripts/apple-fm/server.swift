// enio's bridge to Apple's on-device model (Foundation Models, macOS 26+).
//
// Serves the OpenAI subset enio's client speaks — GET /v1/models and a
// streaming POST /v1/chat/completions with tools — over loopback, so the
// agent uses Apple Intelligence's ~3B model on the Neural Engine exactly the
// way it uses mlx-lm: zero download, and the GPU left entirely free.
//
// The one real design point is tools. enio's harness executes tools (sandbox,
// tracing, allowlists); Foundation Models runs Tool.call inside generation.
// So each tool here is a trap: Tool.call captures the arguments and throws,
// which stops generation at the call. The call goes back to enio as an
// OpenAI tool_calls delta; when enio sends the result, the session is
// rebuilt from a transcript that already holds the call and its output, and
// generation continues to the answer. Measured before building: intercept
// and resume both work, ~50 tok/s warm.
//
// Compiled by enio on first use (scripts/apple-fm → ~/.enio/apple-fm/server)
// with the Command Line Tools' swiftc; no Xcode, no package, no dependencies.

import Foundation
import FoundationModels
import Network

// MARK: - Tools as traps

struct Intercepted: Error {
  let name: String
  let args: String
}

/// Arguments in a canonical form, so the model's `{"path": "x"}` and the
/// harness's `{"path":"x"}` are the same call.
func canonicalArgs(_ json: String) -> String {
  guard let data = json.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data),
        let out = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return json }
  return String(decoding: out, as: UTF8.self)
}

struct WireTool: Tool {
  let name: String
  let description: String
  let parameters: GenerationSchema
  /// Outputs of calls this conversation already made, keyed by canonical
  /// arguments. A call the transcript already answered is served from here
  /// rather than intercepted: the model gets to "re-read" for free, and it
  /// can never loop on the same call — which is what it did when the
  /// transcript alone was expected to carry the result.
  let known: [String: String]

  init(name: String, description: String, schema: [String: Any], known: [String: String]) throws {
    self.name = name
    self.description = description
    self.known = known
    self.parameters = try GenerationSchema(root: dynamicSchema(schema, name: name, description: description), dependencies: [])
  }

  func call(arguments: GeneratedContent) async throws -> String {
    let args = arguments.jsonString
    if let prior = known[canonicalArgs(args)] { return prior }
    throw Intercepted(name: name, args: args)
  }
}

/// JSON schema (the OpenAI tool `parameters` object) → the framework's
/// runtime schema. Strings, numbers, booleans, string enums, arrays and
/// nested objects cover every tool enio ships; anything else reads as a
/// string, which the harness's JSON repair already copes with.
func dynamicSchema(_ schema: [String: Any], name: String, description: String?) -> DynamicGenerationSchema {
  let type = schema["type"] as? String ?? "object"
  if let choices = schema["enum"] as? [String] {
    return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
  }
  switch type {
  case "integer": return DynamicGenerationSchema(type: Int.self)
  case "number": return DynamicGenerationSchema(type: Double.self)
  case "boolean": return DynamicGenerationSchema(type: Bool.self)
  case "array":
    let items = schema["items"] as? [String: Any] ?? ["type": "string"]
    return DynamicGenerationSchema(arrayOf: dynamicSchema(items, name: name + "Item", description: nil))
  case "object":
    let props = schema["properties"] as? [String: Any] ?? [:]
    let required = Set(schema["required"] as? [String] ?? [])
    let properties = props.keys.sorted().map { key -> DynamicGenerationSchema.Property in
      let sub = props[key] as? [String: Any] ?? [:]
      return DynamicGenerationSchema.Property(
        name: key,
        description: sub["description"] as? String,
        schema: dynamicSchema(sub, name: name + "_" + key, description: sub["description"] as? String),
        isOptional: !required.contains(key)
      )
    }
    return DynamicGenerationSchema(name: name, description: description, properties: properties)
  default: return DynamicGenerationSchema(type: String.self)
  }
}

// MARK: - OpenAI request → session

struct ChatRequest {
  var instructions = ""
  var entries: [Transcript.Entry] = []
  var prompt = ""
  var tools: [WireTool] = []
  var stream = true
  var temperature: Double? = nil
  var maxTokens: Int? = nil
}

func parseRequest(_ body: [String: Any]) throws -> ChatRequest {
  var req = ChatRequest()
  req.stream = body["stream"] as? Bool ?? true
  req.temperature = body["temperature"] as? Double
  req.maxTokens = body["max_tokens"] as? Int
  let messages = body["messages"] as? [[String: Any]] ?? []
  let text = { (m: [String: Any]) -> String in (m["content"] as? String) ?? "" }

  // What each earlier call returned, by tool name and canonical arguments.
  var argsByCallID: [String: (String, String)] = [:]
  var known: [String: [String: String]] = [:]
  for m in messages {
    if m["role"] as? String == "assistant", let calls = m["tool_calls"] as? [[String: Any]] {
      for c in calls {
        let fn = c["function"] as? [String: Any] ?? [:]
        argsByCallID[c["id"] as? String ?? ""] = (fn["name"] as? String ?? "", canonicalArgs(fn["arguments"] as? String ?? "{}"))
      }
    }
    if m["role"] as? String == "tool", let (name, args) = argsByCallID[m["tool_call_id"] as? String ?? ""] {
      known[name, default: [:]][args] = text(m)
    }
  }
  for t in body["tools"] as? [[String: Any]] ?? [] {
    guard let fn = t["function"] as? [String: Any], let name = fn["name"] as? String else { continue }
    req.tools.append(try WireTool(name: name, description: fn["description"] as? String ?? "", schema: fn["parameters"] as? [String: Any] ?? [:], known: known[name] ?? [:]))
  }

  // System messages become the session's instructions. Everything else is
  // replayed as transcript, except the final message, which is the prompt.
  var history: [[String: Any]] = []
  for m in messages {
    if m["role"] as? String == "system" { req.instructions += (req.instructions.isEmpty ? "" : "\n\n") + text(m) } else { history.append(m) }
  }
  let toolDefs = req.tools.map { Transcript.ToolDefinition(tool: $0) }
  req.entries.append(.instructions(Transcript.Instructions(segments: [.text(Transcript.TextSegment(content: req.instructions))], toolDefinitions: toolDefs)))

  guard let last = history.last else { req.prompt = ""; return req }
  let lastRole = last["role"] as? String ?? "user"
  let replay = lastRole == "user" ? Array(history.dropLast()) : history
  for m in replay {
    switch m["role"] as? String ?? "" {
    case "user":
      req.entries.append(.prompt(Transcript.Prompt(segments: [.text(Transcript.TextSegment(content: text(m)))])))
    case "assistant":
      if let calls = m["tool_calls"] as? [[String: Any]], !calls.isEmpty {
        var tcs: [Transcript.ToolCall] = []
        for c in calls {
          let fn = c["function"] as? [String: Any] ?? [:]
          let args = fn["arguments"] as? String ?? "{}"
          let content = (try? GeneratedContent(json: args)) ?? GeneratedContent(properties: [:])
          tcs.append(Transcript.ToolCall(id: c["id"] as? String ?? "call_0", toolName: fn["name"] as? String ?? "", arguments: content))
        }
        req.entries.append(.toolCalls(Transcript.ToolCalls(tcs)))
      } else {
        req.entries.append(.response(Transcript.Response(assetIDs: [], segments: [.text(Transcript.TextSegment(content: text(m)))])))
      }
    case "tool":
      req.entries.append(.toolOutput(Transcript.ToolOutput(id: m["tool_call_id"] as? String ?? "call_0", toolName: m["name"] as? String ?? "", segments: [.text(Transcript.TextSegment(content: text(m)))])))
    default: break
    }
  }
  // A turn that ends on a tool result has no user prompt; the framework
  // needs one. The result itself stays in the transcript only — an earlier
  // version copied it into the prompt as well, which spent the window
  // twice on every file read. A repeat of the same call is served from the
  // tool's known outputs, so the model converges either way.
  if lastRole == "user" {
    req.prompt = text(last)
  } else {
    let toolName = (last["name"] as? String).map { " from \($0)" } ?? ""
    req.prompt = "The tool result\(toolName) is above. Continue the task from it; do not repeat a call whose result you already have."
  }
  return req
}

// MARK: - Generation

enum Outcome {
  case text(String)
  case toolCall(name: String, args: String)
  case refused(String)
}

/// One request at a time: the framework rate-limits concurrent sessions,
/// and enio's loop is sequential anyway.
actor Generator {
  func run(_ req: ChatRequest, onDelta: @escaping (String) -> Void) async -> Outcome {
    let session = LanguageModelSession(tools: req.tools, transcript: Transcript(entries: req.entries))
    var options = GenerationOptions()
    if let t = req.temperature { options = GenerationOptions(temperature: t) }
    if let m = req.maxTokens { options.maximumResponseTokens = m }
    var emitted = ""
    do {
      for try await partial in session.streamResponse(to: req.prompt, options: options) {
        let full = partial.content
        if full.count > emitted.count, full.hasPrefix(emitted) {
          let delta = String(full.dropFirst(emitted.count))
          emitted = full
          onDelta(delta)
        }
      }
      return .text(emitted)
    } catch let e as LanguageModelSession.ToolCallError {
      if let i = e.underlyingError as? Intercepted { return .toolCall(name: i.name, args: i.args) }
      return .refused("Tool call failed: \(e.tool.name)")
    } catch let e as LanguageModelSession.GenerationError {
      switch e {
      case .guardrailViolation: return .refused("Apple's on-device model declined this request (its content guardrail).")
      case .exceededContextWindowSize: return .refused("That conversation is longer than the on-device model's window; start a new chat.")
      default: return .refused("On-device model error: \(e)")
      }
    } catch {
      return .refused("On-device model error: \(error)")
    }
  }
}

// MARK: - HTTP (just enough of it, on loopback)

let generator = Generator()
let modelID = "apple-foundation"

func json(_ obj: Any) -> String {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  return String(decoding: data, as: UTF8.self)
}

func chunk(_ delta: [String: Any], finish: String? = nil) -> String {
  var choice: [String: Any] = ["index": 0, "delta": delta]
  if let f = finish { choice["finish_reason"] = f } else { choice["finish_reason"] = NSNull() }
  return "data: " + json(["id": "chatcmpl-apple", "object": "chat.completion.chunk", "model": modelID, "choices": [choice]]) + "\n\n"
}

/// Live connections, retained here: NWConnection does not own its handler's
/// object, so a Conn nobody holds is freed the moment start() returns and
/// every request after "serving" is silently dropped — the first version
/// of this file did exactly that.
let liveQueue = DispatchQueue(label: "apple-fm.live")
var live: [ObjectIdentifier: Conn] = [:]

final class Conn {
  let c: NWConnection
  var buffer = Data()
  init(_ c: NWConnection) { self.c = c }

  func start() {
    let id = ObjectIdentifier(self)
    liveQueue.sync { live[id] = self }
    c.stateUpdateHandler = { [weak self] st in
      switch st {
      case .failed, .cancelled: liveQueue.sync { _ = live.removeValue(forKey: id) }; if case .failed = st { self?.c.cancel() }
      default: break
      }
    }
    c.start(queue: .global())
    read()
  }

  func read() {
    c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, _ in
      guard let self else { return }
      if let d = data { self.buffer.append(d) }
      if let req = self.parse() { self.handle(req) } else if done { self.c.cancel() } else { self.read() }
    }
  }

  func parse() -> (method: String, path: String, body: Data)? {
    guard let sep = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: buffer[..<sep.lowerBound], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2 else { return nil }
    var length = 0
    for l in lines.dropFirst() where l.lowercased().hasPrefix("content-length:") {
      length = Int(l.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
    }
    let bodyStart = sep.upperBound
    guard buffer.count - bodyStart >= length else { return nil }
    return (String(parts[0]), String(parts[1]), buffer[bodyStart..<bodyStart + length])
  }

  func send(_ s: String, done: Bool = false) {
    c.send(content: Data(s.utf8), completion: .contentProcessed { _ in if done { self.c.cancel() } })
  }

  func respond(status: Int, type: String, body: String) {
    send("HTTP/1.1 \(status) OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body, done: true)
  }

  func handle(_ req: (method: String, path: String, body: Data)) {
    if req.method == "GET", req.path.hasPrefix("/v1/models") {
      respond(status: 200, type: "application/json", body: json(["object": "list", "data": [["id": modelID, "object": "model", "owned_by": "apple"]]]))
      return
    }
    guard req.method == "POST", req.path.hasPrefix("/v1/chat/completions") else {
      respond(status: 404, type: "application/json", body: json(["error": ["message": "not found"]]))
      return
    }
    guard let obj = (try? JSONSerialization.jsonObject(with: req.body)) as? [String: Any], let chat = try? parseRequest(obj) else {
      respond(status: 400, type: "application/json", body: json(["error": ["message": "bad request"]]))
      return
    }
    Task {
      if chat.stream {
        send("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")
        send(chunk(["role": "assistant", "content": ""]))
        let outcome = await generator.run(chat) { delta in self.send(chunk(["content": delta])) }
        switch outcome {
        case .text: send(chunk([:], finish: "stop"))
        case .refused(let why): send(chunk(["content": why])); send(chunk([:], finish: "stop"))
        case .toolCall(let name, let args):
          send(chunk(["tool_calls": [["index": 0, "id": "call_0", "type": "function", "function": ["name": name, "arguments": args]]]]))
          send(chunk([:], finish: "tool_calls"))
        }
        send("data: [DONE]\n\n", done: true)
      } else {
        var text = ""
        let outcome = await generator.run(chat) { text += $0 }
        var message: [String: Any] = ["role": "assistant", "content": text]
        var finish = "stop"
        switch outcome {
        case .refused(let why): message["content"] = why
        case .toolCall(let name, let args):
          message["content"] = ""
          message["tool_calls"] = [["id": "call_0", "type": "function", "function": ["name": name, "arguments": args]]]
          finish = "tool_calls"
        case .text: break
        }
        respond(status: 200, type: "application/json", body: json(["id": "chatcmpl-apple", "object": "chat.completion", "model": modelID, "choices": [["index": 0, "message": message, "finish_reason": finish]]]))
      }
    }
  }
}

// MARK: - Main

var port: UInt16 = 8085
if let i = CommandLine.arguments.firstIndex(of: "--port"), i + 1 < CommandLine.arguments.count, let p = UInt16(CommandLine.arguments[i + 1]) { port = p }

switch SystemLanguageModel.default.availability {
case .available: break
case .unavailable(let reason):
  FileHandle.standardError.write(Data("Apple's on-device model is not available: \(reason)\n".utf8))
  exit(2)
}

let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
listener.newConnectionHandler = { Conn($0).start() }
listener.stateUpdateHandler = { st in
  if case .ready = st { print("apple-fm serving \(modelID) on http://127.0.0.1:\(port)/v1"); fflush(stdout) }
  if case .failed(let e) = st { FileHandle.standardError.write(Data("listener failed: \(e)\n".utf8)); exit(1) }
}
listener.start(queue: .global())
dispatchMain()
