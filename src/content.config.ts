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
    category: z.string(),
    staging: z.enum(['green', 'amber', 'red']),
    sources: z.array(
      z.union([
        z.string(),
        z.object({
          url: z.string(),
          title: z.string().optional(),
          type: z.string().optional(),
          reliability: z.string().optional(),
          verified: z.boolean().optional(),
        }),
      ])
    ).optional(),
    rightOfResponse: z.object({
      offered: z.boolean(),
      respondedBy: z.string().optional(),
      response: z.string().optional(),
    }).optional(),
    correction: z.object({
      date: z.coerce.date(),
      detail: z.string(),
    }).optional(),
    editorNote: z.string().optional(),
    coverImage: z.string().optional(),
    coverImageAlt: z.string().optional(),
    coverImageCredit: z.string().optional(),
    aiImageDisclosure: z.boolean().default(false),
    pinned: z.boolean().default(false),
  }),
});

export const collections = { articles };
