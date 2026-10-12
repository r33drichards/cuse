const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const source = path.join(root, "vendor/pi-goal-x");
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
test("complete pinned pi-goal-x source and MIT license are vendored without local artifacts", () => {
 const manifest = JSON.parse(fs.readFileSync(path.join(root, "vendor/pi-goal-x.provenance.json"), "utf8"));
 assert.equal(manifest.commit, "64c5ace87f3400c0b55ef87f2d2912167f53dbaa");
 assert.equal(manifest.version, "0.32.3");
 assert.equal(manifest.license, "MIT");
 assert.equal(manifest.files.length, 555);
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
 assert.match(fs.readFileSync(path.join(source,"LICENSE"),"utf8"),/Copyright \(c\) 2026 Lucas/);
});

test("container ships vendored goal source outside automatic extension discovery", () => {
 const docker = fs.readFileSync(path.join(root,"Dockerfile"),"utf8");
 assert.ok(docker.includes("COPY vendor/pi-goal-x/ /opt/cuse-vendor/pi-goal-x/"));
 assert.ok(docker.includes("COPY vendor/pi-goal-x.provenance.json /opt/cuse-vendor/pi-goal-x.provenance.json"));
});
