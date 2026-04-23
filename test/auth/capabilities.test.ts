import { describe, expect, test } from "bun:test";
import { classifyElicitation } from "../../src/auth/client-facing/capabilities.js";

describe("classifyElicitation", () => {
  test("returns 'url' when client advertises elicitation.url", () => {
    expect(
      classifyElicitation({ elicitation: { url: {} } } as unknown as Parameters<typeof classifyElicitation>[0])
    ).toBe("url");
  });

  test("returns 'fallback' when only elicitation.form is present", () => {
    expect(
      classifyElicitation({ elicitation: { form: {} } } as unknown as Parameters<typeof classifyElicitation>[0])
    ).toBe("fallback");
  });

  test("returns 'fallback' for undefined caps", () => {
    expect(classifyElicitation(undefined)).toBe("fallback");
  });

  test("returns 'fallback' when elicitation missing entirely", () => {
    expect(classifyElicitation({} as Parameters<typeof classifyElicitation>[0])).toBe("fallback");
  });
});
