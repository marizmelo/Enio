/**
 * Deriving the Browse tree from the flat listing the server sends.
 *
 * Pure and dependency-free so the Node suite can test it: the tree is what
 * tells someone which files Enio can reach, and both rules below failed
 * silently once — nothing threw, a folder simply was not there.
 */

/**
 * The immediate children of `path`, folders before files.
 *
 * The project's attached folders are rows in their own right rather than
 * inferred from the listing. A folder is attached whether or not it holds a
 * file the walk reports, and deriving the root purely from paths made an
 * empty one — a repo you just made, a folder holding only dotfiles —
 * disappear from the place that promises every file Enio can reach. Walking
 * into it and reading "this folder is empty" is the true answer; showing
 * nothing was the wrong one.
 */
export function childrenAt(files, attachments, path) {
  const prefix = path.length > 0 ? path.join("/") + "/" : "";
  const folders = new Set();
  const here = new Set();
  if (path.length === 0) {
    for (const a of attachments ?? []) {
      if (a.kind === "file") here.add(a.alias);
      else folders.add(a.alias);
    }
  }
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) here.add(rest);
    else folders.add(rest.slice(0, slash));
  }
  return { folders: [...folders].sort(), here: [...here].sort() };
}

/**
 * The root split into the project's own entries and the workspace's.
 *
 * An entry is the project's when it is an attachment alias, a generated
 * file, or a folder whose files are all generated. A folder holding both
 * generated and workspace files stays with the workspace: the collision is
 * the workspace's namespace, and labelling it "project" would hide that.
 */
export function groupRoots({ folders, here, files, attachments, generated }) {
  const aliases = new Set((attachments ?? []).map((a) => a.alias));
  const generatedSet = new Set(generated);
  const genRoots = new Set(generated.map((g) => g.split("/")[0]));
  const wsRoots = new Set(
    files
      .filter((f) => !aliases.has(f.split("/")[0]) && !generatedSet.has(f))
      .map((f) => f.split("/")[0]),
  );
  const isProjectEntry = (name, isFolder) =>
    aliases.has(name) ||
    (isFolder ? genRoots.has(name) && !wsRoots.has(name) : generatedSet.has(name));
  return {
    projectFolders: folders.filter((d) => isProjectEntry(d, true)),
    projectHere: here.filter((f) => isProjectEntry(f, false)),
    wsFolders: folders.filter((d) => !isProjectEntry(d, true)),
    wsHere: here.filter((f) => !isProjectEntry(f, false)),
  };
}
