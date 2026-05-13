import { assert, describe, expect, test, vi } from "vitest";
import ts from "typescript";
import { Op, TimeoutError, exponentialBackoff } from "./index.js";
import { TaggedError, UnhandledException } from "./errors.js";
import { Result } from "./result.js";
import { resolveAfter } from "./test-utils.js";

describe("OpFactory", () => {
  test("type is 'OpFactory'", () => {
    expect(Op._tag).toBe("OpFactory");
  });

  test("run is a function", () => {
    expect(Op.run).toBeInstanceOf(Function);
  });

  test("pure is a function", () => {
    expect(Op.of).toBeInstanceOf(Function);
  });

  test("empty is a stable singleton op", async () => {
    expect(Op.empty).toBe(Op.empty);

    const result = await Op.empty.run();
    assert(result.isOk(), "should be Ok");
    expect(result.value).toBeUndefined();
  });
});

describe("exponentialBackoff", () => {
  test("is exported and produces exponential delays", () => {
    const getDelay = exponentialBackoff({ base: 100, max: 1000, jitter: 0 });
    expect(getDelay(1)).toBe(100);
    expect(getDelay(2)).toBe(200);
    expect(getDelay(3)).toBe(400);
    expect(getDelay(5)).toBe(1000);
  });

  test("default is exported", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      expect(exponentialBackoff.DEFAULT).toBeInstanceOf(Function);
      expect(exponentialBackoff.DEFAULT(1)).toBe(1_000);
      expect(exponentialBackoff.DEFAULT(2)).toBe(2_000);
      expect(exponentialBackoff.DEFAULT(5)).toBe(16_000);
      expect(exponentialBackoff.DEFAULT(6)).toBe(30_000);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test("normalizes invalid options instead of throwing", () => {
    expect(() => exponentialBackoff({ base: 0, max: 1000, jitter: 0.5 })).not.toThrow();
    expect(() => exponentialBackoff({ base: 100, max: 0, jitter: 0.5 })).not.toThrow();
    expect(() => exponentialBackoff({ base: 100, max: 1000, jitter: -0.5 })).not.toThrow();
    expect(() => exponentialBackoff({ base: 100, max: 1000, jitter: 1.5 })).not.toThrow();
  });
});

describe("UnhandledException", () => {
  test("discriminant and cause", () => {
    const cause = new Error("root");
    const e = new UnhandledException({ cause });
    expect(e._tag).toBe("UnhandledException");
    expect(e.message).toBe("Unhandled exception: root");
    expect(e.cause).toBe(cause);
  });
});

describe("TaggedError", () => {
  test("factory produces typed errors", () => {
    const SmokeError = TaggedError("SmokeError")<{ message: string }>();
    const e = new SmokeError({ message: "x" });
    expect(e._tag).toBe("SmokeError");
    expect(e.name).toBe("SmokeError");
    expect(e.message).toBe("x");
  });
});

describe("Op.of / Op.fail", () => {
  test("pure does not yield errors; fail does not", async () => {
    const okR = await Op.of(7).run();
    assert(okR.isOk(), "should be Ok");
    expect(okR.value).toBe(7);

    const errR = await Op.fail("no").run();
    assert(errR.isErr(), "should be Err");
    expect(errR.error).toBe("no");
  });
});

describe("Op.try", () => {
  test("resolve and mapped reject", async () => {
    const okR = await Op.try(
      () => Promise.resolve(3),
      () => "mapped",
    ).run();
    assert(okR.isOk(), "should be Ok");
    expect(okR.value).toBe(3);

    const errR = await Op.try(
      () => (Math.random() > 1 ? Promise.resolve(3) : Promise.reject("boom")),
      (e) => ({ mappedError: String(e) }),
    ).run();
    assert(errR.isErr(), "should be Err");
    expect(errR.error).toEqual({ mappedError: "boom" });
  });
});

describe("Op.run", () => {
  test("free-function run executes nullary ops", async () => {
    const r1 = await Op.run(Op.of(69));
    assert(r1.isOk(), "should be Ok");
    expect(r1.value).toBe(69);

    const nullary = Op(function* () {
      return 1;
    });
    const r2 = await Op.run(nullary);
    assert(r2.isOk(), "should be Ok");
    expect(r2.value).toBe(1);
  });

  test("free-function run forwards runtime args", async () => {
    const add = Op(function* (a: number, b: number) {
      return a + b;
    });

    const result = await Op.run(add, 30, 39);

    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe(69);
  });
});

describe("Op namespace value", () => {
  test('callable Op has type discriminant Typed<"Op">', () => {
    const p = Op(function* () {
      return yield* Op.of(1);
    });
    expect(p._tag).toBe("Op");
  });

  test("calling a nullary op returns another runnable op", async () => {
    const op = Op.of(69);
    const result = await op()().run();

    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe(69);
  });

  test("yield* can consume a generic helper that returns Op(function*)", async () => {
    type Parsed = { version: string };
    const runTest = async (lift: (value: Parsed) => Op<Parsed, never, []>) => {
      const program = Op(function* () {
        const parsedValue = yield* lift({ version: "1.2.3" });
        return parsedValue;
      });

      const result = await program.run();
      expect(result).toEqual(Result.ok({ version: "1.2.3" }));
    };

    const fns = [
      <T>(t: T) =>
        Op(function* () {
          return t;
        }),
      <T>(t: T) => Op.of(t),
      <T>(t: T) => Op.of(Promise.resolve(t)),
      <T>(t: T) => Op.empty.map(() => t),
      <T>(t: T) => Op.try(() => t),
      <T>(t: T) => Op.try(() => Promise.resolve(t)),
      <T>(t: T) =>
        Op.fail(null).recover(
          (e): e is null => e === null,
          () => t,
        ),
      <T>(t: T) => Op.empty.flatMap(() => Op.of(t)),
      <T>(t: T) => Op.all([Op.of(t)]).map(([x]) => x),
      <T>(t: T) => Op.allSettled([Op.of(t)]).map(([x]) => x.unwrap()),
      <T>(t: T) => Op.settle(Op.of(t)).map((x) => x.unwrap()),
      <T>(t: T) => Op.race([Op.of(t)]),
      <T>(t: T) => Op.any([Op.fail(null), Op.of(t)]),
    ];

    await Promise.all(fns.map(runTest));
  });
});

describe("Op combinators compose with withTimeout / withRetry", () => {
  test("Op.all().withTimeout() times out the whole fan-out", async () => {
    vi.useFakeTimers();
    try {
      const slow = Op.try(() => resolveAfter(1000, 1000));
      const promise = Op.all([slow, slow]).withTimeout(10).run();
      await vi.advanceTimersByTimeAsync(15);
      const r = await promise;
      assert(r.isErr(), "should be Err");
      expect(r.error).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Op.any().withRetry() retries the whole combinator", async () => {
    let attempts = 0;
    const flaky = Op(function* () {
      attempts += 1;
      if (attempts < 2) return yield* Op.fail("nope" as const);
      return yield* Op.of(11);
    });
    const r = await Op.any([flaky])
      .withRetry({ maxAttempts: 3, shouldRetry: () => true, getDelay: () => 0 })
      .run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(11);
    expect(attempts).toBe(2);
  });
});

describe("Op API JSDoc coverage", () => {
  const packageRoot = ts.sys.getCurrentDirectory();
  const tsconfigPath = `${packageRoot}/tsconfig.json`;
  const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const indexPath = `${packageRoot}/src/index.ts`;
  const indexSource = program.getSourceFile(indexPath);
  assert(indexSource, "Expected src/index.ts in TypeScript program");
  const indexModule = checker.getSymbolAtLocation(indexSource);
  assert(indexModule, "Expected module symbol for src/index.ts");
  const opExport = checker.getExportsOfModule(indexModule).find((symbol) => symbol.name === "Op");
  assert(opExport, "Expected Op export in src/index.ts");
  const opValueDeclaration = opExport.valueDeclaration ?? opExport.declarations?.[0];

  const symbolSatisfies = (
    symbol: ts.Symbol | undefined,
    predicate: (resolved: ts.Symbol) => boolean,
  ): boolean => {
    if (!symbol) return false;
    const visited = new Set<ts.Symbol>();

    const inspect = (current: ts.Symbol | undefined): boolean => {
      if (!current) return false;
      if (visited.has(current)) return false;
      visited.add(current);

      const resolved =
        current.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(current) : current;

      if (predicate(resolved)) {
        return true;
      }

      for (const declaration of resolved.declarations ?? []) {
        if (ts.isPropertyAssignment(declaration)) {
          const initializerSymbol = checker.getSymbolAtLocation(declaration.initializer);
          if (inspect(initializerSymbol)) return true;
          continue;
        }

        if (ts.isShorthandPropertyAssignment(declaration)) {
          const shorthandSymbol = checker.getShorthandAssignmentValueSymbol(declaration);
          if (inspect(shorthandSymbol)) return true;
        }
      }

      return false;
    };

    return inspect(symbol);
  };

  const hasDocs = (symbol: ts.Symbol | undefined): boolean =>
    symbolSatisfies(
      symbol,
      (resolved) =>
        resolved.getDocumentationComment(checker).length > 0 ||
        resolved.getJsDocTags(checker).length > 0,
    );

  const hasExample = (symbol: ts.Symbol | undefined): boolean =>
    symbolSatisfies(symbol, (resolved) =>
      resolved.getJsDocTags(checker).some((tag) => tag.name.toLowerCase() === "example"),
    );

  test("all static methods are documented with JSDoc", () => {
    assert(opValueDeclaration, "Expected Op declaration in src/index.ts");
    const opFactoryType = checker.getTypeOfSymbolAtLocation(opExport, opValueDeclaration);

    const propertyNames = opFactoryType.getProperties().map((p) => p.name);
    const documented = propertyNames.filter((name) => hasDocs(opFactoryType.getProperty(name)));
    expect(documented).toEqual(propertyNames);
  });

  test("all static methods include @example", () => {
    assert(opValueDeclaration, "Expected Op declaration in src/index.ts");
    const opFactoryType = checker.getTypeOfSymbolAtLocation(opExport, opValueDeclaration);

    const staticMethodNames = opFactoryType
      .getProperties()
      .filter((property) => {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, opValueDeclaration);
        return propertyType.getCallSignatures().length > 0;
      })
      .map((property) => property.name);
    const withExamples = staticMethodNames.filter((name) =>
      hasExample(opFactoryType.getProperty(name)),
    );

    expect(withExamples).toEqual(staticMethodNames);
  });

  test("all instance methods are documented with JSDoc", () => {
    assert(opValueDeclaration, "Expected Op declaration in src/index.ts");
    const opFactoryType = checker.getTypeOfSymbolAtLocation(opExport, opValueDeclaration);
    const opOfSymbol = opFactoryType.getProperty("of");
    assert(opOfSymbol, "Expected Op.of on Op factory type");

    const opOfType = checker.getTypeOfSymbolAtLocation(opOfSymbol, opValueDeclaration);
    const opOfSignature = opOfType.getCallSignatures()[0];
    assert(opOfSignature, "Expected call signature for Op.of");

    const opInstanceType = checker.getReturnTypeOfSignature(opOfSignature);
    const instanceMethodNames = opInstanceType
      .getProperties()
      .filter((property) => {
        if (property.name.startsWith("__@")) return false;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, opValueDeclaration);
        return propertyType.getCallSignatures().length > 0;
      })
      .map((property) => property.name);
    const documented = instanceMethodNames.filter((name) =>
      hasDocs(opInstanceType.getProperty(name)),
    );

    expect(documented).toEqual(instanceMethodNames);
  });

  test("all instance methods include @example", () => {
    assert(opValueDeclaration, "Expected Op declaration in src/index.ts");
    const opFactoryType = checker.getTypeOfSymbolAtLocation(opExport, opValueDeclaration);
    const opOfSymbol = opFactoryType.getProperty("of");
    assert(opOfSymbol, "Expected Op.of on Op factory type");

    const opOfType = checker.getTypeOfSymbolAtLocation(opOfSymbol, opValueDeclaration);
    const opOfSignature = opOfType.getCallSignatures()[0];
    assert(opOfSignature, "Expected call signature for Op.of");

    const opInstanceType = checker.getReturnTypeOfSignature(opOfSignature);
    const instanceMethodNames = opInstanceType
      .getProperties()
      .filter((property) => {
        if (property.name.startsWith("__@")) return false;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, opValueDeclaration);
        return propertyType.getCallSignatures().length > 0;
      })
      .map((property) => property.name);
    const withExamples = instanceMethodNames.filter((name) =>
      hasExample(opInstanceType.getProperty(name)),
    );

    expect(withExamples).toEqual(instanceMethodNames);
  });
});

describe("unsafeCoerce documentation", () => {
  const packageRoot = ts.sys.getCurrentDirectory();
  const tsconfigPath = `${packageRoot}/tsconfig.json`;
  const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        sourceFile.fileName.startsWith(`${packageRoot}/src/`) &&
        !sourceFile.fileName.endsWith(".d.ts") &&
        !sourceFile.fileName.endsWith(".test.ts"),
    );

  test("all unsafeCoerce calls are preceded by a SAFETY comment", () => {
    const violations: string[] = [];

    const hasPrecedingSafetyComment = (
      lines: readonly string[],
      callLine0Based: number,
    ): boolean => {
      let i = callLine0Based - 1;
      while (i >= 0) {
        const trimmed = lines[i]?.trim() ?? "";
        if (trimmed === "") {
          i -= 1;
          continue;
        }
        if (trimmed.startsWith("//")) {
          if (trimmed.startsWith("// SAFETY:")) {
            return true;
          }
          i -= 1;
          continue;
        }
        return false;
      }
      return false;
    };

    const isValidFormatting = (
      sourceFile: ts.SourceFile,
      node: ts.CallExpression,
      lines: readonly string[],
    ): boolean => {
      const start = node.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const lineText = lines[line] ?? "";
      const prefix = lineText.slice(0, character);
      if (/^(\s|\.\.\.)*$/.test(prefix)) {
        return true;
      }
      return character > 0 && lineText.charAt(character - 1) === " ";
    };

    for (const sourceFile of sourceFiles) {
      const lines = sourceFile.text.split(/\r?\n/);

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const callName = node.expression.text;
          if (callName === "unsafeCoerce") {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const relativePath = sourceFile.fileName.slice(packageRoot.length + 1);
            const where = `${relativePath}:${line + 1}`;
            if (!hasPrecedingSafetyComment(lines, line)) {
              violations.push(`${where} (missing // SAFETY:)`);
            }
            if (!isValidFormatting(sourceFile, node, lines)) {
              violations.push(
                `${where} (unsafeCoerce must be alone after indent or preceded by one space)`,
              );
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
