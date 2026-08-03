import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const allowed = new Set(["@elqora/dgp-spec", "@elqora/dgp-core", "@elqora/dgp-validation"]);
const errors = [];
for (const name of Object.keys(pkg.dependencies ?? {})) if (!allowed.has(name)) errors.push(`Forbidden runtime dependency ${name}.`);
const forbidden = /(?:@elqora\/dgp-ordering|form-palette|react-flow|@xyflow|dgp-studio)/i;
const canonical = new Set(["ProductDefinition", "ProductField", "HandlerService", "ProductDefinitionDiagnostic"]);
for (const file of (await readdir(path.join(root, "src"), { recursive: true })).filter((entry) => entry.endsWith(".ts"))) {
  const relative = path.join("src", file);
  const text = await readFile(path.join(root, relative), "utf8");
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const name = node.moduleSpecifier.getText(source).replaceAll(/["']/g, "");
      if (forbidden.test(name) || (!name.startsWith(".") && !allowed.has(name))) errors.push(`${relative} imports forbidden package ${name}.`);
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && canonical.has(node.name.text)) errors.push(`${relative} reauthors canonical type ${node.name.text}.`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (/\b(flags|estimates|component)\b/.test(text)) errors.push(`${relative} contains a forbidden legacy field.`);
}
if (errors.length > 0) throw new Error(`Workspace boundary violations:\n${errors.join("\n")}`);
console.log("Workspace dependency and source boundaries are valid.");
