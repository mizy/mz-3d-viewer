import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { git, planRelease } from "./release-plan.mjs";

const exec = promisify(execFile);
const releaseModule = new URL("./release-package.mjs", import.meta.url).href;
const packageName = "@mizy/mz-3d-viewer";

function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "mz-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "--quiet", "--initial-branch=main");
  git(cwd, "config", "user.name", "Release test");
  git(cwd, "config", "user.email", "release@example.invalid");
  return cwd;
}

function commit(cwd, message) {
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

test("chooses the highest bump in the release range", (t) => {
  const cwd = repository(t);
  commit(cwd, "chore: previous release");
  git(cwd, "tag", "v1.2.3");
  git(cwd, "tag", "v9.0.0-beta.1");

  commit(cwd, "docs: update installation guides");
  assert.equal(planRelease(cwd).version, null);
  commit(cwd, "fix(loader): preserve CAD units");
  commit(cwd, "perf(viewer): reduce idle work");
  assert.equal(planRelease(cwd).version, "1.2.4");
  commit(cwd, "feat: support another format");
  assert.equal(planRelease(cwd).version, "1.3.0");
  commit(cwd, "refactor(viewer)!: replace the viewer interface");
  assert.equal(planRelease(cwd).version, "2.0.0");
});

test("detects breaking-change footers and skips released or stale commits", (t) => {
  const cwd = repository(t);
  const first = commit(cwd, "chore: previous release");
  git(cwd, "tag", "v0.5.2");
  commit(cwd, "fix: adjust API\n\nBREAKING CHANGE: calls now require a canvas");
  assert.equal(planRelease(cwd).version, "1.0.0");
  git(cwd, "tag", "v1.0.0");
  assert.equal(planRelease(cwd).version, null);
  assert.equal(planRelease(cwd, first).stale, true);
  commit(cwd, "refactor: remove a deprecated API\n\nBREAKING-CHANGE: dispose now takes no arguments");
  assert.equal(planRelease(cwd).version, "2.0.0");
});

test("uses the common ancestor for the manual 0.1.0 release only", (t) => {
  const cwd = repository(t);
  const base = commit(cwd, "feat: pre-existing CAD viewer");
  git(cwd, "switch", "--quiet", "-c", "manual-release");
  commit(cwd, "chore: package the manual release");
  git(cwd, "tag", "-a", "v0.1.0", "-m", "First release");
  git(cwd, "switch", "--quiet", "main");
  commit(cwd, "fix: correct the ESM exports");
  assert.equal(planRelease(cwd).version, "0.1.1");

  git(cwd, "switch", "--quiet", "--detach", base);
  commit(cwd, "chore: unrelated stable release");
  git(cwd, "tag", "v0.2.0");
  git(cwd, "switch", "--quiet", "main");
  assert.throws(() => planRelease(cwd), /is not an ancestor/);
});

async function npmRegistry(t) {
  const versions = { "0.1.0": { name: packageName, version: "0.1.0" } };
  const attachments = new Map();
  const published = [];
  let latest = "0.1.0";
  const server = createServer(async (request, response) => {
    const route = decodeURIComponent(request.url);
    if (request.method === "PUT" && route === `/${packageName}`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const document = JSON.parse(Buffer.concat(chunks));
      const [version] = Object.keys(document.versions);
      assert(!versions[version], `Duplicate publish of ${version}`);
      versions[version] = document.versions[version];
      latest = document["dist-tags"].latest;
      published.push(version);
      for (const [filename, attachment] of Object.entries(document._attachments)) {
        attachments.set(path.basename(filename), Buffer.from(attachment.data, "base64"));
      }
      response.writeHead(201).end("{}");
      return;
    }
    if (route === `/${packageName}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: packageName, versions, "dist-tags": { latest } }));
      return;
    }
    const tarball = attachments.get(path.basename(route));
    if (tarball) response.end(tarball);
    else response.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { registry: `http://127.0.0.1:${server.address().port}`, published };
}

test("publishes and tags, and recovers an interrupted release before publishing the next one", async (t) => {
  const cwd = repository(t);
  const { registry, published } = await npmRegistry(t);
  const origin = path.join(cwd, "origin.git");
  git(cwd, "init", "--quiet", "--bare", origin);
  git(cwd, "remote", "add", "origin", origin);
  commit(cwd, "chore: seed the existing release");
  git(cwd, "tag", "v0.1.0");
  git(cwd, "push", "--quiet", "origin", "main", "v0.1.0");

  const config = path.join(cwd, ".test-npmrc");
  writeFileSync(config, `//${new URL(registry).host}/:_authToken=test-only\n`);
  const manifest = JSON.stringify({ name: "mz-3d-viewer", version: "0.1.0", files: ["dist-lib"] });
  writeFileSync(path.join(cwd, "package.json"), manifest);
  for (const file of [
    "LICENSE", "README.md", "dist-lib/LICENSE.three.txt", "dist-lib/index.js", "dist-lib/types/lib/index.d.ts",
    "dist-lib/occt/step-worker.js", "dist-lib/occt/occt-import-js.js", "dist-lib/occt/occt-import-js.wasm",
    "dist-lib/occt/license.occt.txt", "dist-lib/occt/license.occt-import-js.txt"
  ]) {
    const destination = path.join(cwd, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, "fixture");
  }

  const executeRelease = () => exec(process.execPath, [
    "--input-type=module", "-e",
    `import { publishRelease } from ${JSON.stringify(releaseModule)}; publishRelease(process.cwd(), ${JSON.stringify(registry)});`
  ], {
    cwd,
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: config,
      NPM_CONFIG_CACHE: path.join(cwd, "npm-cache"),
      NPM_CONFIG_FETCH_RETRIES: "0"
    }
  });

  const patch = commit(cwd, "fix: restore the CAD worker");
  const hook = path.join(origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(executeRelease(), /pre-receive hook declined/);
  assert.deepEqual(published, ["0.1.1"]);
  assert.equal(git(cwd, "tag", "--list", "v0.1.1"), "");
  assert.equal(readFileSync(path.join(cwd, "package.json"), "utf8"), manifest);

  rmSync(hook);
  const feature = commit(cwd, "feat: support another format");
  await executeRelease();
  assert.deepEqual(published, ["0.1.1", "0.2.0"]);
  assert.equal(git(origin, "rev-parse", "v0.1.1"), patch);
  assert.equal(git(origin, "rev-parse", "v0.2.0"), feature);
  await executeRelease();
  assert.deepEqual(published, ["0.1.1", "0.2.0"]);
});
