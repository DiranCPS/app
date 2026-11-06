const fs = require("node:fs/promises");
const path = require("node:path");
const JavaScriptObfuscator = require("javascript-obfuscator");

async function obfuscateAssets() {
  const assetsDirectory = path.resolve(__dirname, "..", "dist", "assets");
  const files = (await fs.readdir(assetsDirectory)).filter((file) => file.endsWith(".js"));
  if (files.length === 0) throw new Error("No built JavaScript assets were found to obfuscate.");

  for (const file of files) {
    const assetPath = path.join(assetsDirectory, file);
    const source = await fs.readFile(assetPath, "utf8");
    const result = JavaScriptObfuscator.obfuscate(source, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      selfDefending: false,
      sourceMap: false,
      stringArray: true,
      stringArrayThreshold: 0.2,
      target: "browser-no-eval",
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    });
    await fs.writeFile(assetPath, result.getObfuscatedCode(), "utf8");
    process.stdout.write(`Obfuscated ${file}\n`);
  }
}

obfuscateAssets().catch((error) => {
  console.error("Failed to obfuscate desktop assets:", error);
  process.exitCode = 1;
});
