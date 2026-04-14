import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE } from '../lib/constants';

export async function GET(context) {
  const articles = await getCollection('articles');

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site,
    items: articles
      .sort((a, b) => b.data.publishDate.valueOf() - a.data.publishDate.valueOf())
      .map(article => ({
        title: article.data.title,
        pubDate: article.data.publishDate,
        description: article.data.description,
        link: `/articles/${article.id}/`,
        categories: article.data.tags,
        author: article.data.author,
      })),
    customData: '<language>en-gb</language>',
  });
}
