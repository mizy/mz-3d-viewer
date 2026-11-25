import { execFileSync } from "node:child_process";

export const initialReleaseTag = "v0.1.0";
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function isAncestor(cwd, ancestor, commit) {
  try {
    git(cwd, "merge-base", "--is-ancestor", ancestor, commit);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function releaseBump(message) {
  const subject = message.split("\n", 1)[0];
  const match = /^[a-z]+(?:\([^)]+\))?(!)?: \S/.exec(subject);
  if (match?.[1] || /^BREAKING(?: |-)CHANGE: \S/m.test(message)) return 3;
  if (/^feat(?:\([^)]+\))?: \S/.test(subject)) return 2;
  if (/^(?:fix|perf)(?:\([^)]+\))?: \S/.test(subject)) return 1;
  return 0;
}

/** @entry Infer a stable release from the commits after the latest version tag. */
export function planRelease(cwd, revision = "HEAD") {
  const commit = git(cwd, "rev-parse", "--verify", `${revision}^{commit}`);
  const tag = git(cwd, "tag", "--list", "v*", "--sort=-version:refname")
    .split("\n").find((name) => stableVersion.test(name.slice(1)));
  if (!tag) throw new Error(`Missing the release history. Fetch tags, including ${initialReleaseTag}.`);

  const previousVersion = tag.slice(1);
  let base = tag;
  if (!isAncestor(cwd, tag, commit)) {
    if (isAncestor(cwd, commit, tag)) {
      return { commit, previousVersion, version: null, stale: true };
    }
    // The manual v0.1.0 release was made from a side branch before CI existed.
    if (tag !== initialReleaseTag) {
      throw new Error(`${tag} is not an ancestor of ${commit}. Check the release history.`);
    }
    base = git(cwd, "merge-base", tag, commit);
  }

  const messages = git(cwd, "log", "-z", "--format=%B", `${base}..${commit}`).split("\0");
  const bump = messages.reduce((highest, message) => Math.max(highest, releaseBump(message)), 0);
  if (bump === 0) return { commit, previousVersion, version: null, stale: false };

  const version = previousVersion.split(".").map(Number);
  const index = version.length - bump;
  version[index] += 1;
  version.fill(0, index + 1);
  return { commit, previousVersion, version: version.join("."), stale: false };
}
