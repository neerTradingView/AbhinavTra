import { google } from "googleapis";
import puppeteer from "puppeteer";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const CONFIG = {
  wpApiUrl:
    process.env.WP_API_URL ||
    "https://profitbooking.in/wp-json/scraper/v1/tradingview",
  wpUser: process.env.WP_USER,
  wpPass: process.env.WP_PASS,
};

const GOOGLE_SHEET_CONFIG = {
  sheetId: process.env.SHEET_ID,
  sheetName: process.env.SHEET_NAME,
  serviceAccount: {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
};

// Updated selectors based on current TradingView structure
const SELECTOR_REGISTRY = {
  articleSelectors: [
    'article[class*="article-"]',
    'a[href*="/news/"]',
    '[data-qa-id="news-headline-card"]',
    'div[class*="card-"][class*="news"]',
    'tr[class*="row-"]',
  ],
  headlineSelectors: [
    "[data-overflow-tooltip-text]",
    '[data-qa-id="news-headline-title"]',
    'div[class*="title-"]',
    "h3",
    "h4",
  ],
  providerSelectors: [
    '[class*="provider-"]',
    'span[class*="provider"]',
    'div[class*="source"]',
  ],
  contentSelectors: [
    ".body-KX2tCBZq",
    'div[class*="body-"]',
    'div[class*="content-"]',
    'article[data-role="article"] div[class*="content"]',
    'div[class*="article-body"]',
    '[itemprop="articleBody"]',
  ],
  timeSelectors: [
    "relative-time",
    "time",
    "[datetime]",
    '[class*="date-"]',
    '[class*="time-"]',
  ],
};

// Enhanced date checking function
function isRecentArticle(timestamp, daysBack = 1) {
  try {
    if (!timestamp) return false;

    const articleDate = new Date(timestamp);
    const today = new Date();
    const daysDifference = Math.floor(
      (today - articleDate) / (1000 * 60 * 60 * 24)
    );

    return daysDifference <= daysBack;
  } catch (error) {
    console.error("Error parsing date:", error);
    return false;
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function storeInWordPress(data) {
  if (!CONFIG.wpApiUrl) {
    console.log("WordPress API URL not configured. Skipping storage.");
    return true;
  }

  // Use the more flexible date checking
  if (!isRecentArticle(data.timestamp, 1)) {
    console.log("Skipping storage - article is not recent");
    return false;
  }

  try {
    const response = await axios.post(
      CONFIG.wpApiUrl,
      {
        Headline: data.headline,
        Fullarticle: data.content,
        Provider: data.provider || "General",
        Symbol: data.symbol,
        date: new Date(data.timestamp).toISOString().split("T")[0],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: CONFIG.wpUser,
          password: CONFIG.wpPass,
        },
        timeout: 10000,
      }
    );

    console.log("Stored in WordPress:", response.data);
    return true;
  } catch (error) {
    console.error("WP API Error:", error.response?.data || error.message);
    return false;
  }
}

async function getStockUrlsFromSheet() {
  const auth = new google.auth.JWT({
    email: GOOGLE_SHEET_CONFIG.serviceAccount.email,
    key: GOOGLE_SHEET_CONFIG.serviceAccount.privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  await auth.authorize();
  console.log("NewsProcessor: Google Sheet authentication successful.");

  const sheets = google.sheets({ version: "v4", auth });

  try {
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_CONFIG.sheetId,
      range: `${GOOGLE_SHEET_CONFIG.sheetName}!1:1`,
    });

    const headers = headerResponse.data.values
      ? headerResponse.data.values[0]
      : [];
    if (headers.length === 0) {
      throw new Error(
        "Could not read headers from the Google Sheet. Make sure the sheet is not empty."
      );
    }

    const scrapLinkColIndex = headers.indexOf("Scrap_Link");
    const symbolColIndex = headers.indexOf("Symbol");
    const stockNameColIndex = headers.indexOf("Stock name");

    if (
      scrapLinkColIndex === -1 ||
      symbolColIndex === -1 ||
      stockNameColIndex === -1
    ) {
      throw new Error(
        "Required columns (Scrap_Link, Symbol, Stock name) not found in the Google Sheet."
      );
    }

    const startCol = Math.min(
      symbolColIndex,
      stockNameColIndex,
      scrapLinkColIndex
    );
    const endCol = Math.max(
      symbolColIndex,
      stockNameColIndex,
      scrapLinkColIndex
    );
    const dataRange = `${GOOGLE_SHEET_CONFIG.sheetName}!${String.fromCharCode(
      65 + startCol
    )}:${String.fromCharCode(65 + endCol)}`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_CONFIG.sheetId,
      range: dataRange,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log("No data found in the Google Sheet.");
      return [];
    }

    const stockData = rows
      .slice(1)
      .map((row) => ({
        Symbol: row[symbolColIndex - startCol],
        "Stock name": row[stockNameColIndex - startCol],
        link: row[scrapLinkColIndex - startCol],
      }))
      .filter((entry) => entry.link);

    console.log(`Loaded ${stockData.length} stock URLs from Google Sheet.`);
    return stockData;
  } catch (error) {
    console.error("Error accessing Google Sheet:", error.message);
    if (error.code === 403) {
      console.error(
        "Permission denied. Make sure the service account has read access to the Google Sheet."
      );
    }
    return [];
  }
}

async function trySelectors(page, selectors, symbol) {
  return await page.evaluate(
    (selectors, symbol) => {
      function isRecentArticle(timestamp, maxDaysAgo = 1) {
        try {
          const articleDate = new Date(timestamp);
          const today = new Date();
          const diffTime = today - articleDate;
          const daysDiff = diffTime / (1000 * 60 * 60 * 24);
          return daysDiff <= maxDaysAgo;
        } catch {
          return false;
        }
      }

      const articles = [];

      document
        .querySelectorAll(selectors.articleSelectors.join(","))
        .forEach((element) => {
          // HEADLINE
          let headline = null;
          for (const selector of selectors.headlineSelectors) {
            const h = element.querySelector(selector);
            if (h) {
              headline =
                h.getAttribute("data-overflow-tooltip-text") ||
                h.getAttribute("title") ||
                h.textContent?.trim();
              if (headline) break;
            }
          }

          if (!headline) {
            headline =
              element.getAttribute("data-overflow-tooltip-text") ||
              element.getAttribute("title") ||
              element.textContent?.trim();
          }

          if (!headline) return;

          // SKIP Restricted
          const restrictedIndicators = [
            "sign in to read exclusive news",
            "login to read",
            "subscribe to read",
            "premium content",
            "members only",
            "exclusive news",
            "requires subscription",
          ];

          const headlineLower = headline.toLowerCase();
          if (
            restrictedIndicators.some((indicator) =>
              headlineLower.includes(indicator)
            )
          )
            return;

          // PROVIDER
          let provider = null;
          for (const selector of selectors.providerSelectors) {
            const el = element.querySelector(selector);
            if (el) {
              provider = el.textContent?.trim();
              if (provider) break;
            }
          }

          // LINK
          const link =
            element.href ||
            element.querySelector("a")?.href ||
            element.closest("a")?.href;
          if (!link) return;

          // TIMESTAMP
          let timestamp = null;
          for (const selector of selectors.timeSelectors) {
            const t = element.querySelector(selector);
            if (t) {
              timestamp =
                t.getAttribute("event-time") ||
                t.getAttribute("datetime") ||
                t.getAttribute("data-timestamp") ||
                t.textContent?.trim();
              if (timestamp) break;
            }
          }

          if (!timestamp || !isRecentArticle(timestamp, 3)) return;

          // SYMBOL extraction from images (SVGs)
          const symbolImgs = element.querySelectorAll('img[src*=".svg"]');
          let cardSymbol = null;
          if (symbolImgs.length > 0) {
            const codes = Array.from(symbolImgs)
              .map((img) => {
                const src = img.src;
                const match = src.match(/\/([^\/]+)\.svg$/);
                return match ? match[1].replace(/-/g, "") : null;
              })
              .filter(Boolean);
            if (codes.length > 0) {
              cardSymbol = codes.join("");
            }
          }

          articles.push({
            headline,
            provider: provider || "Unknown",
            timestamp,
            link,
            symbol: cardSymbol || symbol,
          });
        });

      const uniqueArticles = [];
      const seenKeys = new Set();

      for (const article of articles) {
        const key = `${article.headline}-${article.timestamp}-${article.symbol}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          uniqueArticles.push(article);
        }
      }

      return uniqueArticles;
    },
    selectors,
    symbol
  );
}

async function checkIfArticleRequiresLogin(page) {
  try {
    // Whitelist providers that don't require login
    const knownFreeProviders = [
      "moneycontrol",
      "reuters",
      "business standard",
      "investing.com",
    ];

    // Check for free provider text
    const providerText = await page.evaluate(() => {
      const providerEl = document.querySelector('[class*="provider"]');
      return providerEl?.innerText?.toLowerCase().trim() || "";
    });

    if (knownFreeProviders.some((p) => providerText.includes(p))) {
      console.log(
        `Skipping login check - public provider detected: ${providerText}`
      );
      return false;
    }

    // Check for login keywords in visible containers
    const loginIndicators = await page.evaluate(() => {
      const indicators = [
        "sign in to read",
        "login to continue",
        "subscribe to read",
        "premium content",
        "members only",
        "requires subscription",
        "sign up to continue reading",
        "paywall",
        "membership required",
      ];

      const elements = Array.from(
        document.querySelectorAll("div, section, article, header")
      ).filter((el) => el.offsetParent !== null); // Visible only

      return elements.some((el) =>
        indicators.some((text) => el.innerText?.toLowerCase().includes(text))
      );
    });

    // Check for typical login DOM patterns
    const hasLoginElements = await page.evaluate(() => {
      const selectors = [
        '[class*="paywall"]',
        '[class*="subscription"]',
        '[class*="premium"]',
        '[id*="login"]',
        '[class*="sign-in"]',
        'button[class*="subscribe"]',
        '[class*="member-only"]',
        "[data-login-required]",
      ];

      return selectors.some((sel) => document.querySelector(sel));
    });

    return loginIndicators || hasLoginElements;
  } catch (error) {
    console.log("Error during login check:", error.message);
    return false; // Assume no login if check fails
  }
}

async function extractArticleContent(page) {
  // Wait for page to load
  await delay(3000);

  // First check if the article requires login
  const requiresLogin = await checkIfArticleRequiresLogin(page);
  if (requiresLogin) {
    console.log("Article requires login/subscription - skipping");
    return null;
  }

  // Try to extract content from specific selectors
  for (const selector of SELECTOR_REGISTRY.contentSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      const content = await page.$eval(selector, (el) => el.innerText.trim());
      if (content && content.length > 50) {
        // Double-check for restricted content
        const restrictedPhrases = [
          "sign in to read exclusive news",
          "login or create a forever free account",
          "subscribe to read this article",
          "this article is reserved for our members",
          "premium content",
          "requires subscription",
        ];

        const contentLower = content.toLowerCase();
        if (
          !restrictedPhrases.some((phrase) => contentLower.includes(phrase))
        ) {
          console.log(
            `Successfully extracted content (${content.length} characters)`
          );
          return content;
        } else {
          console.log("Content contains restricted phrases - skipping");
          return null;
        }
      }
    } catch (error) {
      continue;
    }
  }

  // Fallback: try to get any publicly available text content
  try {
    const content = await page.evaluate(() => {
      // Look for common article containers
      const containers = [
        "article",
        "main",
        '[role="main"]',
        ".article-content",
        ".content",
        ".post-content",
      ];

      for (const containerSelector of containers) {
        const container = document.querySelector(containerSelector);
        if (container) {
          const text = container.innerText?.trim();
          if (text && text.length > 100) {
            return text;
          }
        }
      }

      return null;
    });

    if (content) {
      // Final check for restricted content
      const restrictedPhrases = [
        "sign in to read exclusive news",
        "login or create a forever free account",
        "subscribe to read this article",
        "this article is reserved for our members",
        "premium content",
        "requires subscription",
      ];

      const contentLower = content.toLowerCase();
      if (!restrictedPhrases.some((phrase) => contentLower.includes(phrase))) {
        console.log(
          `Fallback extraction successful (${content.length} characters)`
        );
        return content;
      }
    }
  } catch (error) {
    console.log("Fallback content extraction failed:", error.message);
  }

  console.log("No publicly available content found");
  return null;
}

async function scrapeTradingViewNews() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=VizDisplayCompositor",
    ],
  });

  const page = await browser.newPage();

  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Block unnecessary resources to speed up loading
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.resourceType() == "stylesheet" || req.resourceType() == "image") {
      req.abort();
    } else {
      req.continue();
    }
  });

  let stockUrls = [];

  try {
    stockUrls = await getStockUrlsFromSheet();
    if (stockUrls.length === 0) {
      console.log("No stock URLs found to process. Exiting.");
      await browser.close();
      return;
    }
  } catch (error) {
    console.error(
      `Failed to retrieve stock URLs from Google Sheet: ${error.message}`
    );
    await browser.close();
    return;
  }

  for (const stockEntry of stockUrls) {
    const stockName = stockEntry["Stock name"];
    const stockSymbol = stockEntry.Symbol;
    const stockLink = stockEntry.link;

    console.log(
      `\nProcessing news for ${stockName} (${stockSymbol}) from ${stockLink} ---`
    );

    try {
      await page.goto(stockLink, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      console.log(`Successfully loaded news page for ${stockSymbol}.`);

      // Wait for content to load
      await delay(3000);
    } catch (error) {
      console.error(
        `Failed to load news page for ${stockSymbol}: ${error.message}`
      );
      continue;
    }

    await autoScroll(page);
    await delay(2000);

    const articlesOnPage = await trySelectors(
      page,
      SELECTOR_REGISTRY,
      stockSymbol
    );

    console.log(
      `Found ${articlesOnPage.length} recent articles on ${stockSymbol}'s news page.`
    );

    let articlesStoredForThisStock = 0;
    let skippedDueToLogin = 0;

    for (const [index, article] of articlesOnPage.entries()) {
      if (!article.link) {
        console.log(
          `Skipping article ${index + 1} with no link for ${stockSymbol}`
        );
        continue;
      }

      const articlePage = await browser.newPage();
      console.log(
        `Processing article ${index + 1}/${
          articlesOnPage.length
        } for ${stockSymbol}: "${article.headline}"`
      );

      try {
        await articlePage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        // Set request interception for article pages too
        await articlePage.setRequestInterception(true);
        articlePage.on("request", (req) => {
          if (
            req.resourceType() == "stylesheet" ||
            req.resourceType() == "image"
          ) {
            req.abort();
          } else {
            req.continue();
          }
        });

        await articlePage.goto(article.link, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        console.log(`Checking if article requires login...`);
        const content = await extractArticleContent(articlePage);
        if (!content) {
          console.log(
            `Skipping article ${
              index + 1
            } for ${stockSymbol} - no accessible content (likely requires login/subscription)`
          );
          skippedDueToLogin++;
          continue;
        }

        const wpData = {
          headline: article.headline,
          content: content,
          symbol: article.symbol || stockSymbol,
          provider: article.provider,
          timestamp: article.timestamp,
        };

        console.log("Data to be sent to WordPress:", {
          ...wpData,
          content: wpData.content.substring(0, 100) + "...",
        });

        const stored = await storeInWordPress(wpData);
        if (stored) {
          articlesStoredForThisStock++;
          console.log(
            `Successfully stored article ${index + 1}/${
              articlesOnPage.length
            } for ${stockSymbol} in WordPress`
          );
        }
      } catch (error) {
        console.error(
          `Error processing article ${index + 1} for ${stockSymbol}: ${
            error.message
          }`
        );
      } finally {
        if (!articlePage.isClosed()) {
          await articlePage.close();
        }
      }

      // Add delay between articles to avoid rate limiting
      await delay(1000);
    }
    console.log(
      `Finished processing ${stockSymbol}: ${articlesStoredForThisStock} articles stored, ${skippedDueToLogin} skipped (login required).`
    );

    // Add delay between stocks
    await delay(2000);
  }

  console.log("\n--- Scraping Complete ---");
  console.log(`Finished processing all stock URLs from Google Sheet.`);

  await browser.close();
  console.log("\nBrowser closed.");
}

scrapeTradingViewNews().catch(console.error);
