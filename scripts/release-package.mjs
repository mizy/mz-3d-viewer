import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, isAncestor, planRelease, stableVersion } from "./release-plan.mjs";

const packageName = "@mizy/mz-3d-viewer";
const githubRegistry = "https://npm.pkg.github.com";

function run(cwd, command, ...args) {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

function npm(cwd, ...args) {
  return run(cwd, "npm", ...args);
}

function packageDirectory() {
  return mkdtempSync(path.join(tmpdir(), "mz-package-release-"));
}

function manifestIn(cwd, tarball) {
  return JSON.parse(run(cwd, "tar", "-xOf", tarball, "package/package.json"));
}

/** @entry Pack the built library with its registry name, release version and source commit. */
function packRelease(cwd, directory, { commit, version }, registry) {
  const staging = path.join(directory, "source");
  mkdirSync(staging);
  for (const entry of ["LICENSE", "README.md", "dist-lib"]) {
    cpSync(path.join(cwd, entry), path.join(staging, entry), { recursive: true });
  }

  const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  writeFileSync(path.join(staging, "package.json"), JSON.stringify({
    ...manifest,
    name: packageName,
    version,
    gitHead: commit,
    publishConfig: { registry }
  }, null, 2) + "\n");

  const [pack] = JSON.parse(npm(staging, "pack", "--ignore-scripts", "--json", "--pack-destination", directory));
  const tarball = path.join(directory, pack.filename);
  const packaged = manifestIn(cwd, tarball);
  assert.equal(packaged.name, packageName);
  assert.equal(packaged.version, version);
  assert.equal(packaged.gitHead, commit);
  const files = new Set(pack.files.map(({ path }) => path));
  for (const file of [
    "LICENSE",
    "README.md",
    "dist-lib/LICENSE.three.txt",
    "dist-lib/index.js",
    "dist-lib/types/lib/index.d.ts",
    "dist-lib/occt/step-worker.js",
    "dist-lib/occt/occt-import-js.js",
    "dist-lib/occt/occt-import-js.wasm",
    "dist-lib/occt/license.occt.txt",
    "dist-lib/occt/license.occt-import-js.txt"
  ]) {
    assert(files.has(file), `Missing ${file} in ${pack.id}`);
  }
  console.log(`Verified ${pack.id} (${pack.size} bytes) from ${commit}`);
  return tarball;
}

function pushReleaseTag(cwd, { version, commit }) {
  const ref = `refs/tags/v${version}`;
  // A lightweight tag points directly at the verified commit without updating main.
  git(cwd, "push", "origin", `${commit}:${ref}`);
  git(cwd, "fetch", "origin", `${ref}:${ref}`);
}

function acknowledgePublishedVersion(cwd, directory, registry, latest) {
  // The manifest inside the published tarball is the durable record if npm accepted
  // the version before the workflow could push its Git tag.
  assert(stableVersion.test(latest), `Unexpected published version: ${latest}`);
  const [pack] = JSON.parse(npm(cwd, "pack", `${packageName}@${latest}`,
    "--registry", registry, "--prefer-online", "--ignore-scripts", "--json", "--pack-destination", directory));
  const { name, version, gitHead } = manifestIn(cwd, path.join(directory, pack.filename));
  assert.equal(name, packageName);
  assert.equal(version, latest);
  assert.match(gitHead ?? "", /^[a-f0-9]{40}$/, `Missing source commit in published ${packageName}@${latest}`);
  if (!isAncestor(cwd, gitHead, "HEAD")) {
    if (isAncestor(cwd, "HEAD", gitHead)) return false;
    throw new Error(`The published ${version} points to ${gitHead} outside this release history.`);
  }
  const published = planRelease(cwd, gitHead);
  assert.equal(published.version, latest, `Cannot reconcile published ${latest} with its source commit`);
  pushReleaseTag(cwd, published);
  console.log(`Restored v${latest} from the published tarball`);
  return true;
}

/** @entry Reconcile registry and Git, then publish and tag the checked-out main commit. */
export function publishRelease(cwd, registry = githubRegistry) {
  let plan = planRelease(cwd);
  if (!plan.version) return;
  const directory = packageDirectory();
  try {
    const latest = JSON.parse(npm(cwd, "view", `${packageName}@latest`, "version",
      "--registry", registry, "--prefer-online", "--json"));
    if (latest !== plan.previousVersion) {
      if (!acknowledgePublishedVersion(cwd, directory, registry, latest)) return;
      plan = planRelease(cwd);
    }
    if (!plan.version) return;

    const tarball = packRelease(cwd, directory, plan, registry);
    console.log(npm(cwd, "publish", tarball, "--registry", registry, "--tag", "latest", "--ignore-scripts").trim());
    pushReleaseTag(cwd, plan);
    console.log(`Published ${packageName}@${plan.version} and pushed v${plan.version}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd();
  const command = process.argv[2];
  if (command === "publish") {
    publishRelease(cwd);
  } else if (command === "check") {
    const plan = planRelease(cwd);
    const directory = packageDirectory();
    try {
      packRelease(cwd, directory, { ...plan, version: plan.version ?? plan.previousVersion }, githubRegistry);
      console.log(plan.version ? `Planned release: v${plan.version}` : "No release required");
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `version=${plan.version ?? ""}\n`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } else {
    throw new Error("Usage: node scripts/release-package.mjs check|publish");
  }
}
