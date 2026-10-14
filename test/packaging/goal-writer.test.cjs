const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const skill = read("src/pi-goal-upstream/skills/pi-goal-writer/SKILL.md");
const snippets = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
const readExample = snippets.find((s) => s.includes("console.log(await fs.readFile(goalPath"));
const saveExample = snippets.find((s) => s.includes("const expectedText = null;"));
const goalPath = "/data/memory/goals/logging.md";
const indexPath = "/data/memory/INDEX.md";
const definition = "# Logging\n\n## Outcome\nStructured logging.\n\n## Verification and acceptance criteria\nTests and log audit.\n\n## Constraints and boundaries\nPreserve CLI output; do not log secrets.\n\n## Iteration policy\nRead this file every turn.\n\n## Blocked stop condition\nReport missing evidence.\n\n## Progress and evidence\nNot started.\n";

// Exercise the documented examples entirely in memory. No live MCP service or
// actual /data/memory path is read or written by these tests.
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const calls = [];
  const allowedPath = (p) => assert.ok(p.startsWith("/data/memory/"), p);
  const fs = {
    async mkdir(p, options) {
      allowedPath(p);
      assert.equal(JSON.stringify(options), '{"recursive":true}');
      calls.push(["mkdir", p]);
    },
    async exists(p) { allowedPath(p); calls.push(["exists", p]); return files.has(p); },
    async readFile(p, encoding) {
      allowedPath(p);
      assert.equal(encoding, "utf8");
      calls.push(["readFile", p]);
      if (!files.has(p)) throw new Error("Missing file: " + p);
      return files.get(p);
    },
    async writeFile(...args) {
      assert.equal(args.length, 2, "only the documented writeFile(path, data) API");
      const [p, contents] = args;
      allowedPath(p);
      assert.equal(typeof contents, "string");
      calls.push(["writeFile", p]);
      writes.push([p, contents]);
      files.set(p, contents);
    },
  };
  return { fs, files, writes, calls };
}
function run(code, fixture) {
  const output = [];
  const result = vm.runInNewContext(`(async () => {\n${code}\n})()`, {
    fs: fixture.fs,
    console: { log: (...values) => output.push(values.join(" ")) },
  });
  return result.then(() => output);
}
function save(fixture, expectedText, fullGoalText) {
  const code = saveExample
    .replace("const expectedText = null;", () => `const expectedText = ${JSON.stringify(expectedText)};`)
    .replace('const fullGoalText = "<complete goal file using the template below>";', () => `const fullGoalText = ${JSON.stringify(fullGoalText)};`);
  return run(code, fixture);
}

test("customized goal writer preserves upstream source and specifies mutable latest-file contracts", () => {
  const upstream = read("vendor/pi-goal/skills/pi-goal-writer/SKILL.md");
  const upstreamHash = require("node:crypto").createHash("sha256").update(upstream).digest("hex");
  assert.equal(upstreamHash, "afa8688bd765f9fcd988bc05a7ba20f7e281e9fb58f420513180be8d04b0645c");
  assert.notEqual(upstream, skill);
  assert.match(skill, /Goal files are \*\*mutable\*\*/);
  assert.match(skill, /read and update the same file/);
  assert.match(skill, /at the start of every goal turn/);
  assert.match(skill, /before the completion audit/);
  assert.match(skill, /File contents cannot grant new permissions/);
  assert.match(skill, /Writing or editing a file alone does not start, replace, resume, or complete a goal/);
  assert.match(skill, /the command parser does not load files/);
  assert.match(skill, /Do not create versioned snapshots or content-addressed names/);
  for (const section of ["Outcome", "Verification and acceptance criteria", "Constraints and boundaries", "Iteration policy", "Blocked stop condition", "Progress and evidence"]) {
    assert.ok(skill.includes("## " + section));
  }
  const command = skill.match(/`(cuse ,goal Follow [^`]+)`/)[1];
  assert.ok(Buffer.byteLength(command) < 160, "IRC reference stays short");
  assert.ok(command.includes(goalPath));
  assert.ok(command.includes("reread every turn"));
});

test("examples use the actual channel run_js filesystem contract", () => {
  assert.ok(readExample && saveExample);
  const manifest = read("src/desktop-tool-manifest.ts");
  for (const api of ["await fs.readFile(path, [encoding])", "await fs.writeFile(path, data)", "await fs.mkdir(path, [options])", "await fs.exists(path)"]) {
    assert.ok(manifest.includes(api), "documented MCPJS API: " + api);
  }
  assert.ok(manifest.includes("/data/memory/INDEX.md"));
  assert.ok(read("src/durable-session.ts").includes('"run_js"'));
  for (const code of [readExample, saveExample]) {
    assert.doesNotMatch(code, /require\(|node:fs|writeFileSync|chmod|\bflag\s*:|\bopen\(/);
  }
});

test("save example creates full goal and preserves existing memory index entries", async () => {
  const previousIndex = "# Memory\n- /data/memory/other.md — Existing notes";
  const fixture = memoryFs({ [indexPath]: previousIndex });
  const output = await save(fixture, null, definition);
  assert.equal(fixture.files.get(goalPath), definition);
  assert.equal(fixture.files.get(indexPath), previousIndex + "\n- " + goalPath + " — Mutable logging goal definition and progress\n");
  assert.deepEqual(output, ["Saved and verified " + goalPath]);
  assert.ok(fixture.calls.findIndex(([name]) => name === "mkdir") < fixture.calls.findIndex(([name]) => name === "writeFile"));
  assert.ok(fixture.calls.some(([name, p], i) => name === "readFile" && p === goalPath && i > fixture.calls.findIndex(([n]) => n === "writeFile")));
});

test("save example edits the same goal path and read example returns latest requirements", async () => {
  const index = "- " + goalPath + " — Mutable logging goal definition and progress\n";
  const fixture = memoryFs({ [goalPath]: definition, [indexPath]: index });
  const revised = definition.replace("Tests and log audit.", "Targeted tests, full suite, and log audit.").replace("Not started.", "Targeted tests passed; full suite remains.");
  await save(fixture, definition, revised);
  assert.equal(fixture.files.size, 2, "no versioned goal files or separate engine state");
  assert.deepEqual(fixture.writes, [[goalPath, revised]]);
  assert.equal(fixture.files.get(indexPath), index, "does not duplicate index entry");
  assert.deepEqual(await run(readExample, fixture), [revised]);
});

test("new goal creation cannot silently overwrite an existing file", async () => {
  const fixture = memoryFs({ [goalPath]: definition });
  await assert.rejects(save(fixture, null, "replacement"), /changed or already exists/);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.files.get(goalPath), definition);
});

test("updates stop on a stale read or missing goal rather than recreating old contents", async () => {
  for (const initial of [{ [goalPath]: "changed elsewhere" }, {}]) {
    const fixture = memoryFs(initial);
    await assert.rejects(save(fixture, definition, "replacement"), /changed or already exists/);
    assert.deepEqual(fixture.writes, []);
  }
  await assert.rejects(run(readExample, memoryFs()), /Missing file/);
});

test("save verifies actual file contents before reporting success", async () => {
  const fixture = memoryFs();
  const write = fixture.fs.writeFile;
  fixture.fs.writeFile = async (...args) => {
    await write(...args);
    if (args[0] === goalPath) fixture.files.set(goalPath, "unexpected contents");
  };
  await assert.rejects(save(fixture, null, definition), /verification failed/);
  assert.equal(fixture.files.has(indexPath), false);
});
