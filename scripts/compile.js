// Compiles contracts/ with solc-js 0.8.26 into build/*.json (abi + bytecode).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const files = ["contracts/SqueekPad.sol", "contracts/SqueekPadImages.sol", "contracts/test/MockSqueek.sol"];
const sources = Object.fromEntries(files.map(f => [f, { content: fs.readFileSync(path.join(root, f), "utf8") }]));

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

function findImports(p) {
  for (const base of [path.join(root, "node_modules"), root]) {
    const full = path.join(base, p);
    if (fs.existsSync(full)) return { contents: fs.readFileSync(full, "utf8") };
  }
  return { error: "not found: " + p };
}

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let failed = false;
for (const e of out.errors || []) {
  console[e.severity === "error" ? "error" : "warn"](e.formattedMessage);
  if (e.severity === "error") failed = true;
}
if (failed) process.exit(1);

fs.mkdirSync(path.join(root, "build"), { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!files.includes(file)) continue;
    fs.writeFileSync(path.join(root, "build", name + ".json"),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 1));
    console.log(`${name}: ${c.evm.deployedBytecode.object.length / 2} bytes runtime`);
  }
}
