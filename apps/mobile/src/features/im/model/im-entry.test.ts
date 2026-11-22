import { describe, expect, it } from "vitest";
import { imEntryState, imEntryToolVisible } from "./im-entry";

describe("im entry rows", () => {
  it("renders no drawer tool and no route while no im capability is registered", () => {
    const state = imEntryState("hidden", "hidden");
    expect(state).toBe("hidden");
    expect(imEntryToolVisible(state)).toBe(false);
  });

  it("keeps the drawer tool absent while both slices are only unavailable", () => {
    expect(imEntryToolVisible(imEntryState("disabled", "hidden"))).toBe(true);
    expect(imEntryToolVisible(imEntryState("hidden", "disabled"))).toBe(true);
    expect(imEntryState("hidden", "hidden")).toBe("hidden");
  });

  it("shows the drawer tool when either slice is enabled", () => {
    expect(imEntryState("enabled", "hidden")).toBe("enabled");
    expect(imEntryState("hidden", "enabled")).toBe("enabled");
  });
});
