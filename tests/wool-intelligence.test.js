import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";

describe("Global Deal Hunter - Wool Intelligence Center", () => {
  it("should load the intelligence center, search deals, and filter categories", async (context) => {
    const testdriver = TestDriver(context);

    // Navigate to the Wool Intelligence Center web application
    await testdriver.provision.chrome({
      url: process.env.APP_URL || "https://emissions-reef-chester-grade.trycloudflare.com",
    });

    // 1. Verify page loads successfully with main title
    const headerResult = await testdriver.assert(
      "the Wool Intelligence Center page is visible with title 全球羊毛情报中心"
    );
    expect(headerResult).toBeTruthy();

    // 2. Search for a specific deal (e.g. OpenRouter)
    await testdriver
      .find("search input field with placeholder 搜索标题、厂商、额度、门槛、风险…")
      .click();
    await testdriver.type("OpenRouter");

    const searchResult = await testdriver.assert(
      "the OpenRouter deal is displayed in search results"
    );
    expect(searchResult).toBeTruthy();

    // 3. Clear the search and verify all deals are restored
    await testdriver
      .find("clear search button × inside the search box")
      .click();

    const clearResult = await testdriver.assert(
      "all 9 deals are displayed after clearing search"
    );
    expect(clearResult).toBeTruthy();

    // 4. Filter by category (大模型 API)
    await testdriver.find("filter chip 大模型 API").click();

    const categoryResult = await testdriver.assert(
      "the category filter is set to 大模型 API and shows 6 deals"
    );
    expect(categoryResult).toBeTruthy();

    // 5. Reset category filter to All (全部)
    await testdriver.find("filter chip 全部").click();

    const resetCategoryResult = await testdriver.assert(
      "the 全部 filter chip is selected and all 9 deals are shown"
    );
    expect(resetCategoryResult).toBeTruthy();
  });
});
