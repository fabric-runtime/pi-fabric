import ts from "typescript";

export const mayReferencePayloads = (code: string): boolean => code.includes("π") || code.includes("\\u");

// Only static π.<key> accesses are provable. The AST excludes strings and comments
// and normalizes Unicode escapes in identifiers.
export function collectGuestPayloadKeys(source: ts.SourceFile): string[] {
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "π") {
      keys.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...keys];
}
