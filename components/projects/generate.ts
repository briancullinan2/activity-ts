import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

export interface CommitActivity
{
	hash: string;
	author: string;
	date: string; // ISO String
	message: string;
	linesAdded: number;
	linesDeleted: number;
	filesChanged: string[];
}

export interface DailyHeatData
{
	date: string; // YYYY-MM-DD
	heatScore: number;
	linesChanged: number;
	commitCount: number;
	filesEdited: string[];
	commits: CommitActivity[];
}

export interface ScreenshotAsset
{
	filename: string;
	relativePath: string;
	date: string; // ISO string
	source: 'filename' | 'mtime';
}

export interface ProjectData
{
	projectName: string;
	localPath?: string;
	remoteUrl?: string;
	lastUpdated: string;
	screenshots: ScreenshotAsset[];
	dailyHeat: Record<string, DailyHeatData | undefined>; // Keyed by YYYY-MM-DD
}

export interface ProjectsDataRegistry
{
	generatedAt: string;
	username: string;
	projects: Record<string, ProjectData>;
}

const MASTER_OUTPUT_FILE = path.join(__dirname, 'projects-data.json');
const CACHE_DIR = __dirname;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'briancullinan2';
const SEARCH_ROOTS = [
	os.homedir(),
	path.join(__dirname, '..')
];

/**
 * Sanitizes project names for safe file creation
 */
function getProjectCacheFilePath(projectName: string): string
{
	const safeName = projectName.replace(/[^a-zA-Z0-9_\-]/g, '_');
	return path.join(CACHE_DIR, `project-data-${safeName}.json`);
}

/**
 * Reads an individual project cache file if it exists
 */
function readProjectCache(projectName: string): ProjectData | null
{
	const filePath = getProjectCacheFilePath(projectName);
	if(fs.existsSync(filePath))
	{
		try
		{
			return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		} catch(e)
		{
			console.warn(`Could not parse cache file for ${projectName}. Will recreate.`);
		}
	}
	return null;
}

/**
 * Writes/updates an individual project cache file
 */
function writeProjectCache(projectData: ProjectData): void
{
	const filePath = getProjectCacheFilePath(projectData.projectName);
	fs.writeFileSync(filePath, JSON.stringify(projectData, null, 2), 'utf-8');
}

/**
 * Helper to recursively scan directories for .git repositories
 */
function findGitRepositories(dir: string, depth = 0, maxDepth = 4): string[]
{
	if(depth > maxDepth) return [];
	const gitRepos: string[] = [];

	try
	{
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		if(entries.some(e => e.isDirectory() && e.name === '.git'))
		{
			return [dir];
		}

		for(const entry of entries)
		{
			if(entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
			{
				const fullPath = path.join(dir, entry.name);
				gitRepos.push(...findGitRepositories(fullPath, depth + 1, maxDepth));
			}
		}
	} catch(err)
	{
		// Ignore permission errors during deep traversal
	}

	return gitRepos;
}

/**
 * Parses screenshot images inside a repository directory
 */
function extractScreenshots(repoPath: string): ScreenshotAsset[]
{
	const screenshots: ScreenshotAsset[] = [];
	const exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

	function scan(currentDir: string)
	{
		try
		{
			const items = fs.readdirSync(currentDir, { withFileTypes: true });
			for(const item of items)
			{
				if(item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules')
				{
					scan(path.join(currentDir, item.name));
				} else if(item.isFile())
				{
					const lowerName = item.name.toLowerCase();
					const ext = path.extname(lowerName);
					if(exts.includes(ext) && lowerName.includes('screenshot'))
					{
						const fullPath = path.join(currentDir, item.name);
						const relPath = path.relative(repoPath, fullPath);
						const stats = fs.statSync(fullPath);

						const dateMatch = item.name.match(/\d{4}[-_\.]\d{2}[-_\.]\d{2}/);
						let dateStr = stats.mtime.toISOString();
						let source: 'filename' | 'mtime' = 'mtime';

						if(dateMatch)
						{
							const parsed = new Date(dateMatch[0].replace(/[-_\.]/g, '-'));
							if(!isNaN(parsed.getTime()))
							{
								dateStr = parsed.toISOString();
								source = 'filename';
							}
						}

						screenshots.push({
							filename: item.name,
							relativePath: relPath,
							date: dateStr,
							source
						});
					}
				}
			}
		} catch(e) { }
	}

	scan(repoPath);
	return screenshots.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/**
 * Extracts Git commits and file patch metrics locally with verbose progress statistics
 */
function processLocalGitHistory(repoPath: string, existingData: ProjectData | null): Record<string, DailyHeatData | undefined>
{
	const dailyHeatMap: Record<string, DailyHeatData | undefined> = existingData?.dailyHeat ? { ...existingData.dailyHeat } : {};

	const logCmd = `git log --all --pretty=format:"%H|%an|%ad|%s" --date=iso`;
	let rawLog = '';
	try
	{
		rawLog = execSync(logCmd, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
	} catch(e)
	{
		return dailyHeatMap;
	}

	if(!rawLog.trim()) return dailyHeatMap;

	const lines = rawLog.trim().split('\n');
	const todayKey = new Date().toISOString().split('T')[0];

	let commitsProcessed = 0;
	let daysSkipped = 0;
	let daysEvaluated = 0;

	for(const line of lines)
	{
		const parts = line.split('|');
		if(parts.length < 4) continue;

		const [hash, author, dateStr, ...msgParts] = parts;
		const message = msgParts.join('|');
		const commitDate = new Date(dateStr);
		if(isNaN(commitDate.getTime())) continue;

		const dayKey = commitDate.toISOString().split('T')[0];

		// Idempotency check: Skip re-evaluation if day is already cached and not today
		if(dailyHeatMap[dayKey] && dayKey !== todayKey)
		{
			daysSkipped++;
			continue;
		}

		daysEvaluated++;
		const statCmd = `git show --numstat --format="" ${hash}`;
		let numstatRaw = '';
		try
		{
			numstatRaw = execSync(statCmd, { cwd: repoPath, encoding: 'utf-8' });
		} catch(e)
		{
			continue;
		}

		let commitAdded = 0;
		let commitDeleted = 0;
		const filesChanged: string[] = [];

		const statLines = numstatRaw.trim().split('\n');
		for(const statLine of statLines)
		{
			const [add, del, file] = statLine.split('\t');
			if(file)
			{
				filesChanged.push(file);
				const a = parseInt(add, 10);
				const d = parseInt(del, 10);
				if(!isNaN(a)) commitAdded += a;
				if(!isNaN(d)) commitDeleted += d;
			}
		}

		const commitObj: CommitActivity = {
			hash,
			author,
			date: commitDate.toISOString(),
			message,
			linesAdded: commitAdded,
			linesDeleted: commitDeleted,
			filesChanged
		};

		if(!dailyHeatMap[dayKey])
		{
			dailyHeatMap[dayKey] = {
				date: dayKey,
				heatScore: 0,
				linesChanged: 0,
				commitCount: 0,
				filesEdited: [],
				commits: []
			};
		}

		const dayEntry = dailyHeatMap[dayKey]!;

		if(!dayEntry.commits.some(c => c.hash === hash))
		{
			dayEntry.commits.push(commitObj);
			dayEntry.commitCount += 1;
			dayEntry.linesChanged += (commitAdded + commitDeleted);
			dayEntry.filesEdited = Array.from(new Set([...dayEntry.filesEdited, ...filesChanged]));
			dayEntry.heatScore = Math.min(100, (dayEntry.commitCount * 10) + Math.floor(dayEntry.linesChanged / 15));
			commitsProcessed++;
		}
	}

	console.log(`   └─ Commit Stats: ${lines.length} total commits analyzed | ${commitsProcessed} new commits indexed | ${daysSkipped} cached days skipped`);
	return dailyHeatMap;
}

/**
 * Fallback to GitHub REST API if repo is missing locally using native fetch
 */
async function fetchRemoteGitHubEvents(username: string, currentProjects: Record<string, ProjectData>): Promise<Record<string, ProjectData>>
{
	const remoteProjects: Record<string, ProjectData> = {};

	try
	{
		const url = `https://api.github.com/users/${username}/events`;
		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Node-Script',
				'Accept': 'application/vnd.github.v3+json'
			}
		});

		if(!response.ok)
		{
			console.warn(`GitHub API request failed: HTTP ${response.status} ${response.statusText}`);
			return remoteProjects;
		}

		const events = await response.json() as any[];
		if(Array.isArray(events))
		{
			for(const ev of events)
			{
				if(ev.type === 'PushEvent' && ev.repo)
				{
					const repoName = ev.repo.name.split('/')[1] || ev.repo.name;
					const dayKey = new Date(ev.created_at).toISOString().split('T')[0];

					if(!currentProjects[repoName])
					{
						const existingCache = readProjectCache(repoName);
						const proj: ProjectData = existingCache || {
							projectName: repoName,
							remoteUrl: `https://github.com/${ev.repo.name}`,
							lastUpdated: new Date().toISOString(),
							screenshots: [],
							dailyHeat: {}
						};

						if(!proj.dailyHeat[dayKey])
						{
							proj.dailyHeat[dayKey] = {
								date: dayKey,
								heatScore: ev.payload?.commits ? ev.payload.commits.length * 15 : 10,
								linesChanged: 0,
								commitCount: ev.payload?.commits ? ev.payload.commits.length : 1,
								filesEdited: [],
								commits: (ev.payload?.commits || []).map((c: any) => ({
									hash: c.sha,
									author: c.author?.name || username,
									date: ev.created_at,
									message: c.message,
									linesAdded: 0,
									linesDeleted: 0,
									filesChanged: []
								}))
							};
						}

						writeProjectCache(proj);
						remoteProjects[repoName] = proj;
					}
				}
			}
		}
	}
	catch(err)
	{
		console.warn('GitHub API fallback skipped or throttled:', err);
	}

	return remoteProjects;
}

/**
 * Main execution script runner
 */
export async function generate()
{
	const startTime = Date.now();
	console.log('------------------------------------------------------------');
	console.log('🚀 Starting Projects Data Generator (Per-Project Cache Mode)');
	console.log('------------------------------------------------------------');

	const registry: ProjectsDataRegistry = {
		generatedAt: new Date().toISOString(),
		username: GITHUB_USERNAME,
		projects: {}
	};

	// 1. Discover all local .git projects
	console.log('🔍 Discovering local Git repositories...');
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
	const totalRepos = repoList.length;
	console.log(`Found ${totalRepos} repositories. Processing history...\n`);

	// 2. Process each local repo individually
	let repoIndex = 1;
	for(const repoPath of repoList)
	{
		const projectName = path.basename(repoPath);
		const repoStartTime = Date.now();
		console.log(`[${repoIndex}/${totalRepos}] Processing: ${projectName}`);

		let remoteUrl = '';
		try
		{
			remoteUrl = execSync('git config --get remote.origin.url', { cwd: repoPath, encoding: 'utf-8' }).trim();
		} catch(e) { }

		const existingCache = readProjectCache(projectName);
		const updatedDailyHeat = processLocalGitHistory(repoPath, existingCache);
		const screenshots = extractScreenshots(repoPath);

		const updatedProjectData: ProjectData = {
			projectName,
			localPath: repoPath,
			remoteUrl: remoteUrl || existingCache?.remoteUrl,
			lastUpdated: new Date().toISOString(),
			screenshots,
			dailyHeat: updatedDailyHeat
		};

		writeProjectCache(updatedProjectData);
		registry.projects[projectName] = updatedProjectData;

		const repoElapsed = ((Date.now() - repoStartTime) / 1000).toFixed(2);
		console.log(`   └─ Completed in ${repoElapsed}s | Screenshots found: ${screenshots.length}`);

		repoIndex++;
	}

	// 3. Fallback to GitHub REST API for missing repos
	console.log('\n🌐 Checking GitHub REST API for un-cloned remote contributions...');
	const remoteProjects = await fetchRemoteGitHubEvents(GITHUB_USERNAME, registry.projects);
	for(const [name, projData] of Object.entries(remoteProjects))
	{
		registry.projects[name] = projData;
	}

	registry.generatedAt = new Date().toISOString();

	// 4. Save combined master file
	fs.writeFileSync(MASTER_OUTPUT_FILE, JSON.stringify(registry, null, 2), 'utf-8');

	const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log('\n------------------------------------------------------------');
	console.log(`✅ Success! Master output generated at: ${MASTER_OUTPUT_FILE}`);
	console.log(`⏱️ Total Execution Time: ${totalTimeSec}s for ${totalRepos} projects`);
	console.log('------------------------------------------------------------');
}

// CLI Direct Execution
if(require.main === module)
{
	generate().catch(err =>
	{
		console.error('Fatal execution error during generation:', err);
		process.exit(1);
	});
}
