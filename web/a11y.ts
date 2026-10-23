import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function expectAccessible(
  page: Page,
  workflow: string,
): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary,
    })),
  }));

  expect(violations, `${workflow} has accessibility violations`).toEqual([]);
}

export async function expectNoHorizontalOverflow(
  page: Page,
  workflow: string,
): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>('*')]
      .map((element) => ({
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className && typeof element.className === 'string' ? `.${element.className.trim().replaceAll(/\s+/g, '.')}` : ''}`,
        right: Math.round(element.getBoundingClientRect().right),
      }))
      .filter((element) => element.right > window.innerWidth + 1)
      .slice(0, 8),
  }));

  expect(
    dimensions.scrollWidth,
    `${workflow} overflows the viewport horizontally: ${JSON.stringify(dimensions.overflowing)}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

export async function expectResponsiveAccessible(
  page: Page,
  workflow: string,
): Promise<void> {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, workflow);
    await expectAccessible(page, workflow);
  }
}
