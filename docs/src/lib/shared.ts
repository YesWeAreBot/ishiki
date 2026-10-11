import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Ishiki';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

// 文档所在的仓库与分支，用于页面上的「在 GitHub 上编辑」链接
export const gitConfig = {
  user: 'YesWeAreBot',
  repo: 'ishiki',
  branch: 'feat/koishi-plugin',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
