/// <reference types="node" />

import * as fs from 'fs';
import * as path from 'path';

export interface IBlogPost
{
	id: string;
	title: string;
	date: string;
	author: string;
	categories: string[];
	tags: string[];
	summary: string;
	content_html: string;
	modern_insight_2026?: string;
	tldr?: string;
	project?: string;
	latest_commit?: string;
}

export interface ITagWeight
{
	text?: string;
	size?: number;
	count: number;
	postIds: string[];
}

export interface IBlogAggregateData
{
	generatedAt: string;
	totalPosts: number;
	tags: ITagWeight[];
	posts: IBlogPost[];
}

function decodeHtmlEntities(str: string): string
{
	if(!str) return '';
	return str
		.replace(/</g, '<')
		.replace(/>/g, '>')
		.replace(/&/g, '&')
		.replace(/"/g, '"')
		.replace(/'/g, "'");
}

export function generateBlogData(): IBlogAggregateData
{
	const dataDir = path.join(__dirname, 'data');
	const files = fs.readdirSync(dataDir);

	const filePattern = /^blog-data-\d{4}-\d{1,2}\.json|projects-code-\d{4}-\d{1,2}-\d{1,2}\.json$/i;
	const targetFiles = files.filter(f => filePattern.test(f));

	const postsMap = new Map();
	const tagFrequency = new Map<string, ITagWeight>();

	targetFiles.forEach(file =>
	{
		const filePath = path.join(dataDir, file);
		try
		{
			const content = fs.readFileSync(filePath, 'utf-8');
			const posts: IBlogPost[] = JSON.parse(content);

			posts.forEach(post =>
			{
				// Decode HTML string if encoded with entities
				if(post.content_html && post.content_html.includes('<'))
				{
					post.content_html = decodeHtmlEntities(post.content_html);
				}

				postsMap.set(post.id, post);

				// Aggregate Tag Frequencies & Reverse Post ID Mappings
				const allTags = [...(post.tags || []), ...(post.categories || [])];
				allTags.forEach(rawTag =>
				{
					const normalized = rawTag.toLowerCase().trim();
					if(!normalized) return;

					if(!tagFrequency.has(normalized))
					{
						tagFrequency.set(normalized, { count: 0, postIds: [] });
					}
					const entry = tagFrequency.get(normalized)!;
					entry.count += 1;
					entry.postIds[entry.postIds.length] = post.id;
				});
			});
		} catch(err)
		{
			console.error(`Error reading ${file}:`, err);
		}
	});

	// Sort Posts Chronologically Descending
	const sortedPosts = Array.from(postsMap.values()).sort(
		(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
	);

	// Compute Font Scaling for D3 Word Cloud (Min size: 12px, Max size: 48px)
	const maxCount = Math.max(...Array.from(tagFrequency.values()).map(v => v.count), 1);
	const minCount = Math.min(...Array.from(tagFrequency.values()).map(v => v.count), 1);

	const tagWeights: ITagWeight[] = Array.from(tagFrequency.entries()).map(([text, data]) =>
	{
		const normalizedSize = maxCount === minCount
			? 24
			: 12 + Math.round(((data.count - minCount) / (maxCount - minCount)) * 36);

		return {
			text,
			count: data.count,
			size: normalizedSize,
			postIds: Array.from(data.postIds)
		};
	}).sort((a, b) => b.count - a.count);

	const aggregateResult: IBlogAggregateData = {
		generatedAt: new Date().toISOString(),
		totalPosts: sortedPosts.length,
		tags: tagWeights,
		posts: sortedPosts
	};

	const outputPath = path.join(dataDir, 'blog-data.json');
	fs.writeFileSync(outputPath, JSON.stringify(aggregateResult, null, 2), 'utf-8');
	console.log(`[generate.ts] Aggregated ${sortedPosts.length} posts & ${tagWeights.length} tags -> ${outputPath}`);

	return aggregateResult;
}

if(require.main === module)
{
	generateBlogData();
}
