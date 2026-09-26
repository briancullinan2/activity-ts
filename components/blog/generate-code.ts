import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Remarkable } from 'remarkable';
import { AUTHOR_MATCHES, findGitRepositories, SEARCH_ROOTS } from '../projects/generate';
import { IBlogPost } from './generate';

const md = new Remarkable({ html: true, xhtmlOut: true, breaks: true });

const PROFILE_PATH = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || '';
const PROJECT_PATH = path.join(__dirname, 'data');

interface FileSummary
{
	additions: string[];
	deletions: string[];
}

interface PatchSummary
{
	files: Record<string, FileSummary>;
	totalAdditions: number;
	totalDeletions: number;
}

/**
 * Parses raw git diff patches into file additions/deletions.
 */
function parsePatch(patchContent: string): PatchSummary
{
	const lines = patchContent.split('\n');
	const summary: PatchSummary = {
		files: {},
		totalAdditions: 0,
		totalDeletions: 0,
	};

	let currentFile: string | null = null;

	lines.forEach((line) =>
	{
		if(line.startsWith('+++ b/'))
		{
			currentFile = line.replace('+++ b/', '').trim();
			summary.files[currentFile] = { additions: [], deletions: [] };
		} else if(currentFile && summary.files[currentFile])
		{
			if(line.startsWith('+') && !line.startsWith('+++'))
			{
				const addedLine = line.slice(1).trim();
				summary.files[currentFile].additions.push(addedLine);
				summary.totalAdditions++;
			} else if(line.startsWith('-') && !line.startsWith('---'))
			{
				const deletedLine = line.slice(1).trim();
				summary.files[currentFile].deletions.push(deletedLine);
				summary.totalDeletions++;
			} else if(
				!line.startsWith('@') &&
				!line.startsWith('diff') &&
				!line.startsWith('index') &&
				!line.startsWith('---')
			)
			{
				const addedLine = line.slice(1).trim();
				summary.files[currentFile].additions.push(addedLine);
			}
		}
	});

	return summary;
}

/**
 * Converts a string into a safe filesystem-friendly filename.
 */
function safeurl(str: string): string
{
	return str.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}


/**
 * Dynamically loads llama.cpp and creates an LLM generation context.
 */
async function createLLMSession()
{
	const { getLlama, LlamaChatSession } = await (eval('import("node-llama-cpp")') as Promise<any>);

	console.log('[LLM] Initializing llama.cpp runtime...');
	const llama = await getLlama();
	const modelPath = path.join(__dirname, 'models', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf');

	const model = await llama.loadModel({ modelPath });
	const context = await model.createContext({ contextSize: 2048 });

	const session = new LlamaChatSession({
		contextSequence: context.getSequence(),
	});

	return { model, session };
}
/**
 * Helper to parse LLM output using JSON, backtick stripping, or key-value regex fallbacks.
 */
function parseLLMResponse(rawText: string, fallbackId: string, fallbackDate: string): IBlogPost
{
	let cleaned = rawText.trim();

	// Strategy 1: Direct JSON parse
	try
	{
		return JSON.parse(cleaned);
	} catch { }

	// Strategy 2: Strip Markdown code blocks
	const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if(codeBlockMatch)
	{
		try
		{
			return JSON.parse(codeBlockMatch[1]);
		} catch { }
	}

	// Strategy 3: Regex fallback to parse key-value pairs
	const extractString = (key: string): string =>
	{
		const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i');
		const m = cleaned.match(re);
		return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
	};

	const extractArray = (key: string): string[] =>
	{
		const re = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i');
		const m = cleaned.match(re);
		if(!m) return [];
		return m[1]
			.split(',')
			.map((s) => s.trim().replace(/^"|"$/g, ''))
			.filter(Boolean);
	};

	const id = extractString('id') || fallbackId;
	const title = extractString('title') || 'Automated Commit Log Summary';
	const date = extractString('date') || fallbackDate;
	const author = extractString('author') || 'Brian Cullinan';
	const summary = extractString('summary') || 'Daily code changes log.';
	const contentHtml = extractString('content_html') || cleaned;
	const tldr = extractString('tldr') || summary;
	const categories = extractArray('categories');
	const tags = extractArray('tags');

	return {
		id,
		title,
		date,
		author,
		categories: categories.length ? categories : ['Engineering', 'Code Update'],
		tags: tags.length ? tags : ['git', 'commit-log'],
		summary,
		content_html: contentHtml,
		tldr,
	};
}

/**
 * Blogs about recent commits made by specific authors in a project repository.
 */
export async function blogAboutCode(
	project?: string,
	timeframe: number = 3,
	llmContext?: { model: any; session: any; }
): Promise<string | void>
{
	let targetProject = project;

	if(!targetProject)
	{
		targetProject = path.basename(path.resolve(path.join(__dirname, '..')));
	}

	if(!fs.existsSync(targetProject) && fs.existsSync(path.join(PROFILE_PATH, targetProject)))
	{
		targetProject = path.join(PROFILE_PATH, targetProject);
	}

	if(
		targetProject.includes('://') &&
		fs.existsSync(path.basename(targetProject).replace('.git', ''))
	)
	{
		targetProject = path.join(PROFILE_PATH, path.basename(targetProject).replace('.git', ''));
	}

	if(!fs.existsSync(targetProject))
	{
		console.error(`[Error] Project path does not exist: ${targetProject}`);
		return;
	}

	// --- Top Loader: Daily Cache Setup & Skip Check ---
	const now = new Date();
	const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

	if(!fs.existsSync(PROJECT_PATH))
	{
		fs.mkdirSync(PROJECT_PATH, { recursive: true });
	}

	const cacheFilePath = path.join(PROJECT_PATH, `projects-code-${dateStr}.json`);
	let dailyCache: IBlogPost[] = [];

	if(fs.existsSync(cacheFilePath))
	{
		try
		{
			dailyCache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
		} catch
		{
			dailyCache = [];
		}
	}

	// Build git log command filtering by specified author patterns
	const authorArgs = AUTHOR_MATCHES.map((author) => `--author=${author}`);
	const logArgs = ['log', `--since=${timeframe}.days`, ...authorArgs];

	let result = spawnSync('git', logArgs, {
		cwd: targetProject,
		timeout: 3000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	const commits = result.stdout.toString();
	const matches = [...commits.matchAll(/commit ([a-z0-9]+)/gi)];
	const first = matches[0];
	const last = matches[matches.length - 1];

	if(!first || !last)
	{
		console.log(`No commits found for target authors in ${targetProject} over past ${timeframe} days.`);
		return;
	}

	const projectName = path.basename(targetProject);
	const latestCommitHash = first[1];

	// Skip generation if already processed today for this exact commit or project
	const existingProject = dailyCache.find(p => p.project === projectName);
	if(
		existingProject &&
		(existingProject.latest_commit === latestCommitHash || existingProject.id)
	)
	{
		console.log(`[Cache Hit] Skipping ${projectName} - already processed today for commit ${latestCommitHash}.`);
		return JSON.stringify(existingProject);
	}

	console.log(`Processing commit range in ${projectName}:`, first[1], last[1]);

	let diffResult;
	if(first[1] === last[1])
	{
		diffResult = spawnSync('git', ['diff', '-U5', `${first[1]}~1`, first[1]], {
			cwd: targetProject,
			timeout: 3000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} else
	{
		diffResult = spawnSync('git', ['diff', '-U5', last[1], first[1]], {
			cwd: targetProject,
			timeout: 3000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	}

	const codePatch = diffResult.stdout.toString();
	const summary = parsePatch(codePatch);
	const summaryOutputs: string[] = [];
	const files = Object.keys(summary.files);

	if(files.length === 0)
	{
		console.log(`No modified files found in patch diff.`);
		return;
	}

	// Load LLM if not provided
	const { model, session } = llmContext || (await createLLMSession());

	for(const file of files)
	{
		if(file.includes('cache')) continue;

		console.log(`Working on file: ${file}`);

		const prompt = `Act as Brian Cullinan (bjcullinan), a pragmatic software engineer and hardware hacker who writes technical blog posts focused on clean architecture, modular abstractions, and system-of-systems engineering. Maintain a direct, structurally organized, and conversationally confident tone with dry wit, highlighting concrete frameworks, protocols, and hands-on solutions over abstract concepts. Lead directly with the technical problem or status update in sentence 1, and conclude naturally with progress notes or actionable next steps without using corporate buzzwords or generic AI summaries.

Write a technical blog post entry analyzing these code files changes and do not repeat this information back, make it purely analysis and examplary. Do not over explain every single commit:
File name for reference: ${file}
Commits for reference:
${commits.substring(0, 1000)}
Additions for reference:
${summary.files[file].additions.join('\n').substring(0, 1000)}
Deletions for reference:
${summary.files[file].deletions.join('\n').substring(0, 1000)}

I need this to be witty and smart like a snarky pull request log message but also keep it very brief so we can get through a lot of files. Only respond like you're writing in first person as me telling a story about the code.
`;

		console.log('User: ' + prompt);
		console.log('AI: ');
		let fileBlogPost = '';

		await session.prompt(prompt, {
			maxTokens: 500,
			temperature: 0.7,
			onToken(tokens: any)
			{
				const decoded = model.detokenize(tokens);
				process.stdout.write(decoded);
				fileBlogPost += decoded;
			},
		});

		console.log('\n');
		summaryOutputs.push(`## ${file}\n\n${fileBlogPost}`);
	}

	const prompt = `Act as Brian Cullinan (bjcullinan), a pragmatic software engineer and hardware hacker who writes technical blog posts focused on clean architecture, modular abstractions, and system-of-systems engineering. Maintain a direct, structurally organized, and conversationally confident tone with dry wit, highlighting concrete frameworks, protocols, and hands-on solutions over abstract concepts. Lead directly with the technical problem or status update in sentence 1, and conclude naturally with progress notes or actionable next steps without using corporate buzzwords or generic AI summaries.

Write a technical blog post entry analyzing these code files changes and do not repeat this information back, make it purely analysis and examplary. Do not over explain every single commit:
Files for reference:
${files}
Commits for reference:
${commits}
Change log for reference:
${summaryOutputs.join('\n\n')}
I need this to be witty and smart like a snarky pull request log message but also keep it very brief so we can get through a lot of files. Only respond like you're writing in first person as me telling a story about the code.
I need it in this format:
{
    "id": "${dateStr}-${projectName}-${latestCommitHash.substring(0, 7)}",
    "title": "Update to ${projectName}",
    "date": "${now.toISOString()}",
    "author": "Brian Cullinan",
    "categories": [
        "Engineering",
        "Code Update"
    ],
    "tags": [
        "git",
        "${projectName}"
    ],
    "summary": "Summary of changes made to ${projectName}.",
    "content_html": "<article class=\\"blog-post\\">...</article>",
    "tldr": "Quick TL;DR summary."
}
`;

	console.log('User: ' + prompt);
	console.log('AI: ');
	let fileBlogPost2 = '';

	await session.prompt(prompt, {
		maxTokens: 800,
		temperature: 0.7,
		onToken(tokens: any)
		{
			const decoded = model.detokenize(tokens);
			process.stdout.write(decoded);
			fileBlogPost2 += decoded;
		},
	});

	console.log('\n');

	// --- Bottom Loader: LLM Output Parsing, Fallbacks, and Merged Cache Writer ---
	const fallbackId = `${dateStr}-${projectName}-${latestCommitHash.substring(0, 7)}`;
	const fallbackDate = now.toISOString();

	let postData = parseLLMResponse(fileBlogPost2, fallbackId, fallbackDate);

	// Attach execution metadata to ensure commit-level idempotency
	postData.project = projectName;
	postData.latest_commit = latestCommitHash;

	// Merge this project's result into the daily cache file
	dailyCache[dailyCache.length] = postData;
	fs.writeFileSync(cacheFilePath, JSON.stringify(dailyCache, null, 2));

	console.log(`[Cache Updated] Project '${projectName}' merged into ${cacheFilePath}`);

	return JSON.stringify(postData, null, 2);
}

// CLI Execution check
if(require.main === module /*|| process.argv[1]?.endsWith('generate.ts')*/)
{
	(async () =>
	{
		console.log('[CLI] Scanning user profile directory for git projects...');

		// 1. Discover all local .git projects
		const discoveredRepos = new Set<string>();
		for(const searchRoot of SEARCH_ROOTS)
		{
			if(fs.existsSync(searchRoot))
			{
				const repos = findGitRepositories(searchRoot);
				repos.forEach(r => discoveredRepos.add(r));
			}
		}

		const repoList = Array.from(discoveredRepos);
		console.log(`Found ${repoList.length} git repository/repositories.`);

		const llmContext = await createLLMSession();

		for(const projectPath of repoList)
		{
			console.log(`\n--- Checking Repository: ${projectPath} ---`);
			await blogAboutCode(projectPath, 3, llmContext);
		}
	})().catch((err) =>
	{
		console.error('[Fatal Error]:', err);
		process.exit(1);
	});
}

export default blogAboutCode;
