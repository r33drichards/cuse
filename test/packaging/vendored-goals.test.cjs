const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const source = path.join(root, "vendor/pi-goal");
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
test("complete pinned pi-goal source and MIT license are vendored without local artifacts", () => {
 const manifest = JSON.parse(fs.readFileSync(path.join(root, "vendor/pi-goal.provenance.json"), "utf8"));
 assert.equal(manifest.commit, "3f100be5434454d3388755a119d01caca9127c16");
 assert.equal(manifest.version, "0.1.7");
 assert.equal(manifest.license, "MIT");
 assert.equal(manifest.files.length, 15);
 const expected = new Set(manifest.files.map(f => f.path));
 function walk(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
   const name = prefix + entry.name;
   assert.ok(!entry.isSymbolicLink(), "unexpected symlink: " + name);
   if (entry.isDirectory()) {assert.ok(![".git", "node_modules"].includes(entry.name));walk(path.join(dir,entry.name),name+"/");}
   else assert.ok(expected.delete(name), "unexpected source file: " + name);
  }
 }
 walk(source);assert.equal(expected.size, 0);
 for (const file of manifest.files) {
  const bytes = fs.readFileSync(path.join(source,file.path));
  assert.equal(hash("sha256",bytes),file.sha256,file.path);
  assert.equal(hash("sha1",Buffer.concat([Buffer.from("blob " + bytes.length + "\0"),bytes])),file.gitBlob,file.path);
 }
 assert.match(fs.readFileSync(path.join(source,"LICENSE"),"utf8"),/MIT License/);
 assert.match(fs.readFileSync(path.join(source,"LICENSE"),"utf8"),/Copyright \(c\) 2026 Michael Livshits/);
});

test("container ships vendored goal source outside automatic extension discovery", () => {
 const docker = fs.readFileSync(path.join(root,"Dockerfile"),"utf8");
 assert.ok(docker.includes("COPY vendor/pi-goal/ /opt/cuse-vendor/pi-goal/"));
 assert.ok(docker.includes("COPY vendor/pi-goal.provenance.json /opt/cuse-vendor/pi-goal.provenance.json"));
});

test("durable port reuses upstream pure helpers and prompts without source drift", () => {
 for (const name of ["goal-state.ts", "usage.ts"]) {
  assert.deepEqual(fs.readFileSync(path.join(root,"src/pi-goal-upstream",name)), fs.readFileSync(path.join(source,".pi/extensions/pi-goal",name)));
 }
 assert.deepEqual(fs.readFileSync(path.join(root,"src/pi-goal-upstream/LICENSE")),fs.readFileSync(path.join(source,"LICENSE")));
 const manifest = JSON.parse(fs.readFileSync(path.join(root,"vendor/pi-goal.provenance.json"),"utf8"));
 assert.equal(manifest.runtimeCustomizations.length,1);
 for (const customization of manifest.runtimeCustomizations) {
  assert.equal(hash("sha256",fs.readFileSync(path.join(source,customization.upstreamPath))),customization.upstreamSha256);
  assert.equal(hash("sha256",fs.readFileSync(path.join(root,customization.path))),customization.sha256);
  assert.notEqual(customization.sha256,customization.upstreamSha256);
 }
 const upstream = fs.readFileSync(path.join(source,".pi/extensions/pi-goal/index.ts"),"utf8");
 const prompts = fs.readFileSync(path.join(root,"src/pi-goal-prompts.ts"),"utf8");
 const expected = upstream.slice(upstream.indexOf("function continuationPrompt("),upstream.indexOf("\nfunction queueContinuation(")).replace("function continuationPrompt(","export function continuationPrompt(").replace("function budgetLimitPrompt(","export function budgetLimitPrompt(");
 assert.ok(prompts.includes(expected));
 assert.ok(!fs.existsSync(path.join(root,"src/goal-ledger.ts")));
 assert.ok(!fs.existsSync(path.join(root,"vendor/pi-goal-x")));
});
