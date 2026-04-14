import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishDate: z.coerce.date(),
    author: z.string().default('mm!ke'),
    tags: z.array(z.string()),
    category: z.enum([
      'news',
      'feature',
      'profile',
      'analysis',
      'post-mortem',
      'community',
      'regulatory',
      'research',
    ]),
    staging: z.enum(['green', 'amber', 'red']),
    sources: z.array(z.string()).optional(),
    rightOfResponse: z.object({
      offered: z.boolean(),
      respondedBy: z.string().optional(),
      response: z.string().optional(),
    }).optional(),
    correction: z.object({
      date: z.coerce.date(),
      detail: z.string(),
    }).optional(),
    editorNote: z.string(),
    coverImage: z.string().optional(),
    coverImageAlt: z.string().optional(),
    coverImageCredit: z.string().optional(),
    aiImageDisclosure: z.boolean().default(false),
  }),
});

export const collections = { articles };
