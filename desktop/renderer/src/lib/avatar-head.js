import { TalkingHead } from "@met4citizen/talkinghead";
import { LipsyncEn } from "@met4citizen/talkinghead/modules/lipsync-en.mjs";

/**
 * The TalkingHead instance, configured for this window.
 *
 * Two of its defaults do not survive a bundle: it loads lip-sync modules
 * with a dynamic import() of a computed path, which fails under file://,
 * and it defaults to Finnish. So the module list is empty and the English
 * module is registered by hand -- mandatory, not optional: with an empty
 * registry the first spoken sentence throws. Draco stays off because its
 * decoder path is a CDN and nothing here fetches at runtime.
 */
export function createTalkingHead(node, { view = "head", rotate = false } = {}) {
  const head = new TalkingHead(node, {
    cameraView: view,
    cameraRotateEnable: rotate,
    cameraPanEnable: false,
    cameraZoomEnable: false,
    lipsyncModules: [],
    lipsyncLang: "en",
    modelFPS: 30,
    // The default of 1 is blurry on a Retina display; 2 is enough.
    modelPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    avatarMood: "neutral",
    dracoEnabled: false,
    // Mostly on you, idle or speaking: the library's defaults glance away
    // most of the time, which reads as a face that is not listening.
    avatarIdleEyeContact: 0.85,
    avatarSpeakingEyeContact: 0.85,
  });
  head.lipsync.en = new LipsyncEn();
  return head;
}

export function disposeTalkingHead(head) {
  try {
    head.dispose();
  } catch {
    // Half-built heads throw on teardown; nothing else to free.
  }
  // dispose() leaves its AudioContext open; each mount would leak one.
  try {
    head.audioCtx?.close();
  } catch {
    // Already closed.
  }
}
