/// <reference types="node" />
const { D3Node } = require('d3-node');
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

export const AUTHOR_MATCHES = [
	'brian',
	'brian cullinan',
	'megamindbrian@gmail.com',
	'bjcullinan@gmail.com',
	'bjcullinan@bjcullinan.com',
	'megamind'
];

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


export interface CompactHeatPoint
{
	date: string;       // YYYY-MM-DD
	heatScore: number;  // 0-100
	commitCount: number;
}

export interface ProjectSummary
{
	projectName: string;
	remoteUrl?: string;
	localPath?: string;
	lastUpdated: string;
	activeYears: number[];
	activeMonths: string[]; // YYYY-MM
	totalCommits: number;
	totalLinesChanged: number;
	screenshotCount: number;
}

export interface CompactMasterManifest
{
	generatedAt: string;
	username: string;
	projectCount: number;
	availableMonths: string[];
	availableYears: number[];
	projects: ProjectSummary[];
	flatHeatIndex: Record<string, CompactHeatPoint[]>; // project -> lightweight heat points
}


export interface MonthlyProjectRegistry
{
	yearMonth: string;
	generatedAt: string;
	username: string;
	projects: Record<string, ProjectData>;
}



const MASTER_OUTPUT_FILE = path.join(__dirname, 'projects-data.json');
const CACHE_DIR = __dirname;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'briancullinan2';
export const SEARCH_ROOTS = [
	os.homedir(),
	path.join(__dirname, '..')
];

/**
 * Sanitizes project names for safe file creation
 */
function getProjectCacheFilePath(projectName: string): string
{
	const safeName = projectName.replace(/[^a-zA-Z0-9_\-]/g, '_');
	return path.join(CACHE_DIR, 'data', `project-data-${safeName}.json`);
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
export function findGitRepositories(dir: string, depth = 0, maxDepth = 4): string[]
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
	const dailyHeatMap: Record<string, DailyHeatData | undefined> = {};

	// Build a fast commit cache lookup from existing data
	const cachedCommitMap = new Map<string, CommitActivity>();
	if(existingData?.dailyHeat)
	{
		for(const dayEntry of Object.values(existingData.dailyHeat))
		{
			if(dayEntry && Array.isArray(dayEntry.commits))
			{
				for(const commit of dayEntry.commits)
				{
					if(commit && commit.hash)
					{
						cachedCommitMap.set(commit.hash, commit);
					}
				}
			}
		}
	}

	const authorArgs = AUTHOR_MATCHES.map(a => `--author="${a}"`).join(' ');
	const logCmd = `git log --all ${authorArgs} --pretty=format:"%H|%an|%ad|%s" --date=iso-strict`;
	let rawLog = '';
	try
	{
		console.log(logCmd);
		rawLog = execSync(logCmd, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
	} catch(e)
	{
		return dailyHeatMap;
	}

	if(!rawLog.trim()) return dailyHeatMap;

	const lines = rawLog.trim().split('\n');

	let commitsProcessed = 0;
	let cachedCommitsReused = 0;

	for(const line of lines)
	{
		const parts = line.split('|');
		if(parts.length < 4) continue;

		const [hash, author, dateStr, ...msgParts] = parts;
		const message = msgParts.join('|');
		const commitDate = new Date(dateStr);
		if(isNaN(commitDate.getTime())) continue;

		const dayKey = `${commitDate.getFullYear()}-${String(commitDate.getMonth() + 1).padStart(2, '0')}-${String(commitDate.getDate()).padStart(2, '0')}`;

		let commitObj: CommitActivity;

		// Check if commit exists in cache to skip git show --numstat
		if(cachedCommitMap.has(hash))
		{
			const cached = cachedCommitMap.get(hash)!;
			commitObj = {
				hash,
				author,
				date: commitDate.toISOString(),
				message,
				linesAdded: cached.linesAdded || 0,
				linesDeleted: cached.linesDeleted || 0,
				filesChanged: cached.filesChanged || []
			};
			cachedCommitsReused++;
		}
		else
		{
			// Execute numstat only for uncached/new commits
			const statCmd = `git show --numstat --format="" ${hash}`;
			let numstatRaw = '';
			try
			{
				numstatRaw = execSync(statCmd, { cwd: repoPath, encoding: 'utf-8' });
			} catch(e)
			{
				console.warn(e);
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

			commitObj = {
				hash,
				author,
				date: commitDate.toISOString(),
				message,
				linesAdded: commitAdded,
				linesDeleted: commitDeleted,
				filesChanged
			};
			commitsProcessed++;
		}

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

		// Prevent duplicates in day array
		if(!dayEntry.commits.some(c => c.hash === hash))
		{
			dayEntry.commits.push(commitObj);
		}
	}

	// Recalculate daily aggregate scores cleanly for every day key
	for(const dayEntry of Object.values(dailyHeatMap))
	{
		if(!dayEntry) continue;

		let totalLines = 0;
		const allFiles: string[] = [];

		for(const c of dayEntry.commits)
		{
			totalLines += (c.linesAdded + c.linesDeleted);
			if(Array.isArray(c.filesChanged))
			{
				allFiles.push(...c.filesChanged);
			}
		}

		dayEntry.commitCount = dayEntry.commits.length;
		dayEntry.linesChanged = totalLines;
		dayEntry.filesEdited = Array.from(new Set(allFiles));
		dayEntry.heatScore = Math.min(100, (dayEntry.commitCount * 10) + Math.floor(totalLines / 15));
	}

	console.log(`   └─ Commit Stats: ${lines.length} total commits analyzed | ${commitsProcessed} new numstats fetched | ${cachedCommitsReused} commits reused from cache`);
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
	// 4. Group all project data by month and write `project-data-YYYY-MM.json`
	console.log('\n📅 Grouping activity by YYYY-MM into monthly history files...');

	const now = new Date();
	const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

	const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

	const monthlyDataMap: Record<string, Record<string, ProjectData>> = {};

	// Bucket daily heat entries and commits by YYYY-MM across all repos
	for(const [projName, projData] of Object.entries(registry.projects))
	{
		for(const [dayKey, dailyEntry] of Object.entries(projData.dailyHeat))
		{
			if(!dailyEntry) continue;

			const monthKey = dayKey.substring(0, 7); // Extracts "YYYY-MM"

			if(!monthlyDataMap[monthKey])
			{
				monthlyDataMap[monthKey] = {};
			}

			if(!monthlyDataMap[monthKey][projName])
			{
				monthlyDataMap[monthKey][projName] = {
					projectName: projName,
					localPath: projData.localPath,
					remoteUrl: projData.remoteUrl,
					lastUpdated: projData.lastUpdated,
					screenshots: projData.screenshots.filter(s => s.date.startsWith(monthKey)),
					dailyHeat: {}
				};
			}

			monthlyDataMap[monthKey][projName].dailyHeat[dayKey] = dailyEntry;
		}
	}

	let filesWritten = 0;
	let filesSkipped = 0;

	for(const [monthKey, projectsInMonth] of Object.entries(monthlyDataMap))
	{
		const monthlyFileName = `project-data-${monthKey}.json`;
		const monthlyFilePath = path.join(CACHE_DIR, 'data', monthlyFileName);

		const isCurrentOrPrevMonth = (monthKey === currentMonthKey || monthKey === prevMonthKey);

		// Skip writing historical months if the file already exists on disk
		if(fs.existsSync(monthlyFilePath) && !isCurrentOrPrevMonth)
		{
			filesSkipped++;
			continue;
		}

		const monthlyRegistry: MonthlyProjectRegistry = {
			yearMonth: monthKey,
			generatedAt: new Date().toISOString(),
			username: GITHUB_USERNAME,
			projects: projectsInMonth
		};

		fs.writeFileSync(monthlyFilePath, JSON.stringify(monthlyRegistry, null, 2), 'utf-8');
		filesWritten++;
	}

	const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log('------------------------------------------------------------');
	console.log(`✅ Success! Monthly history written to ${CACHE_DIR}`);
	console.log(`📊 Monthly files created/updated: ${filesWritten} | Historical skipped: ${filesSkipped}`);
	console.log(`⏱️ Total Execution Time: ${totalTimeSec}s for ${totalRepos} projects`);
	console.log('------------------------------------------------------------');


	// 5. Generate yearly standalone SVG heatmaps for every active project year
	console.log('\n🎨 Generating standalone SVG heatmaps for each project year...');

	let svgFilesWritten = 0;
	let svgFilesSkipped = 0;

	for(const [projName, projData] of Object.entries(registry.projects))
	{
		const safeProjName = projName.replace(/[^a-zA-Z0-9_\-]/g, '_');

		// Extract all years that have recorded activity
		const activeYears = new Set<number>();
		for(const [dayKey, dayEntry] of Object.entries(projData.dailyHeat))
		{
			if(dayEntry && dayEntry.commitCount > 0)
			{
				const year = parseInt(dayKey.substring(0, 4), 10);
				if(!isNaN(year))
				{
					activeYears.add(year);
				}
			}
		}

		// Generate one SVG per active year
		for(const year of activeYears)
		{
			const svgFileName = `heatmap-${safeProjName}-${year}.svg`;
			const svgFilePath = path.join(CACHE_DIR, 'heat-maps', svgFileName);

			// Skip re-rendering historical years if SVG already exists and is not the current year
			const currentYearNum = new Date().getFullYear();
			if(fs.existsSync(svgFilePath) && year !== currentYearNum)
			{
				svgFilesSkipped++;
				continue;
			}

			const svgString = renderD3HeatmapForYearSVG(projData.dailyHeat, year);
			fs.writeFileSync(svgFilePath, svgString, 'utf-8');
			svgFilesWritten++;
		}
	}

	console.log(`📊 SVG Heatmaps generated: ${svgFilesWritten} created/updated | ${svgFilesSkipped} cached historical skipped`);

	// 6. Generate standalone SVG heatmaps combining ALL projects per active year
	console.log('\n🎨 Generating ALL-projects standalone SVG heatmaps per year...');

	let globalSvgWritten = 0;
	let globalSvgSkipped = 0;

	// Collect all active years across all registered projects
	const allActiveYears = new Set<number>();
	for(const projData of Object.values(registry.projects))
	{
		for(const [dayKey, dayEntry] of Object.entries(projData.dailyHeat))
		{
			if(dayEntry && dayEntry.commitCount > 0)
			{
				const year = parseInt(dayKey.substring(0, 4), 10);
				if(!isNaN(year))
				{
					allActiveYears.add(year);
				}
			}
		}
	}

	const currentYearNum = new Date().getFullYear();

	for(const year of allActiveYears)
	{
		const globalSvgFileName = `heatmap-${year}.svg`;
		const globalSvgFilePath = path.join(CACHE_DIR, 'heat-maps', globalSvgFileName);

		// Skip historical years if already generated
		if(fs.existsSync(globalSvgFilePath) && year !== currentYearNum)
		{
			globalSvgSkipped++;
			continue;
		}

		// Aggregate dailyHeat map across ALL projects for this year
		const combinedDailyHeat: Record<string, DailyHeatData> = {};

		for(const projData of Object.values(registry.projects))
		{
			for(const [dayKey, dayEntry] of Object.entries(projData.dailyHeat))
			{
				if(!dayEntry || !dayKey.startsWith(`${year}-`)) continue;

				if(!combinedDailyHeat[dayKey])
				{
					combinedDailyHeat[dayKey] = {
						date: dayKey,
						heatScore: 0,
						linesChanged: 0,
						commitCount: 0,
						filesEdited: [],
						commits: []
					};
				}

				const aggregated = combinedDailyHeat[dayKey];
				aggregated.commitCount += dayEntry.commitCount || 0;
				aggregated.linesChanged += dayEntry.linesChanged || 0;

				if(Array.isArray(dayEntry.filesEdited))
				{
					aggregated.filesEdited = Array.from(new Set([...aggregated.filesEdited, ...dayEntry.filesEdited]));
				}

				if(Array.isArray(dayEntry.commits))
				{
					aggregated.commits.push(...dayEntry.commits);
				}

				aggregated.heatScore = Math.min(100, (aggregated.commitCount * 10) + Math.floor(aggregated.linesChanged / 15));
			}
		}

		const globalSvgString = renderD3HeatmapForYearSVG(combinedDailyHeat, year);
		fs.writeFileSync(globalSvgFilePath, globalSvgString, 'utf-8');
		globalSvgWritten++;
	}

	console.log(`📊 Global ALL-Projects Heatmaps: ${globalSvgWritten} created/updated | ${globalSvgSkipped} cached historical skipped`);

	// 6. Write lightweight master `projects-data.json` index manifest
	console.log('\n📋 Building lightweight master manifest: projects-data.json...');

	const availableMonthsSet = new Set<string>();
	const availableYearsSet = new Set<number>();
	const projectSummaries: ProjectSummary[] = [];
	const flatHeatIndex: Record<string, CompactHeatPoint[]> = {};

	for(const [projName, projData] of Object.entries(registry.projects))
	{
		const activeYears = new Set<number>();
		const activeMonths = new Set<string>();
		const heatPoints: CompactHeatPoint[] = [];

		let totalCommits = 0;
		let totalLinesChanged = 0;

		for(const [dayKey, dayEntry] of Object.entries(projData.dailyHeat))
		{
			if(!dayEntry || dayEntry.commitCount === 0) continue;

			const year = parseInt(dayKey.substring(0, 4), 10);
			const monthKey = dayKey.substring(0, 7);

			if(!isNaN(year))
			{
				activeYears.add(year);
				availableYearsSet.add(year);
			}
			activeMonths.add(monthKey);
			availableMonthsSet.add(monthKey);

			totalCommits += dayEntry.commitCount;
			totalLinesChanged += dayEntry.linesChanged;

			heatPoints.push({
				date: dayKey,
				heatScore: dayEntry.heatScore,
				commitCount: dayEntry.commitCount
			});
		}

		const sortedYears = Array.from(activeYears).sort((a, b) => b - a);
		const sortedMonths = Array.from(activeMonths).sort((a, b) => b.localeCompare(a));

		projectSummaries.push({
			projectName: projName,
			remoteUrl: projData.remoteUrl,
			localPath: projData.localPath,
			lastUpdated: projData.lastUpdated,
			activeYears: sortedYears,
			activeMonths: sortedMonths,
			totalCommits,
			totalLinesChanged,
			screenshotCount: projData.screenshots.length
		});

		// Store flattened daily scores for rendering immediate broad grids
		flatHeatIndex[projName] = heatPoints.sort((a, b) => a.date.localeCompare(b.date));
	}

	const masterManifest: CompactMasterManifest = {
		generatedAt: new Date().toISOString(),
		username: GITHUB_USERNAME,
		projectCount: projectSummaries.length,
		availableMonths: Array.from(availableMonthsSet).sort((a, b) => b.localeCompare(a)),
		availableYears: Array.from(availableYearsSet).sort((a, b) => b - a),
		projects: projectSummaries.sort((a, b) => a.projectName.localeCompare(b.projectName)),
		flatHeatIndex
	};

	fs.writeFileSync(MASTER_OUTPUT_FILE, JSON.stringify(masterManifest, null, 2), 'utf-8');

	const manifestSizeBytes = fs.statSync(MASTER_OUTPUT_FILE).size;
	const manifestSizeKB = (manifestSizeBytes / 1024).toFixed(2);

	console.log(`✅ Lightweight manifest saved to: ${MASTER_OUTPUT_FILE} (${manifestSizeKB} KB)`);
}


/**
 * Renders a single-year SVG vector heatmap using dailyHeat records directly
 */
export function renderD3HeatmapForYearSVG(
	dailyHeat: Record<string, DailyHeatData | undefined>,
	year: number
): string
{
	const d3n = new D3Node();
	const d3 = d3n.d3;

	const containerWidth = 900;
	const containerHeight = 120;
	const margin = { top: 15, right: 20, bottom: 15, left: 35 };
	const innerWidth = containerWidth - margin.left - margin.right;
	const innerHeight = containerHeight - margin.top - margin.bottom;

	const stepX = innerWidth / 54;
	const stepY = innerHeight / 7;

	const colorScale = d3.scaleLinear()
		.range(['#1b1b3a', '#007acc', '#4ec9b0'])
		.domain([0, 50, 100]);

	const svg = d3n.createSVG(containerWidth, containerHeight)
		.attr('xmlns', 'http://www.w3.org/2000/svg')
		.attr('viewBox', `0 0 ${containerWidth} ${containerHeight}`)
		.attr('preserveAspectRatio', 'none')
		.attr('class', 'git-heatmap-svg');

	const rootG = svg.append('g')
		.attr('transform', `translate(${margin.left},${margin.top})`);

	const yearG = rootG.append('g')
		.attr('transform', 'translate(20, 0)');

	yearG.append('text')
		.text(year)
		.attr('fill', '#888')
		.attr('font-size', '10px')
		.attr('font-family', 'sans-serif')
		.attr('transform', `translate(-25, ${stepY * 3.5}) rotate(-90)`)
		.attr('text-anchor', 'middle');

	const daysInYear = d3.timeDays(new Date(year, 0, 1), new Date(year + 1, 0, 1));
	const weekFormat = d3.timeFormat('%W');
	const dateFormat = d3.timeFormat('%Y-%m-%d');

	yearG.selectAll('.day')
		.data(daysInYear)
		.enter().append('rect')
		.attr('class', 'day')
		.attr('width', Math.max(1, stepX - 1))
		.attr('height', Math.max(1, stepY - 1))
		.attr('x', (d: Date) => parseInt(weekFormat(d), 10) * stepX)
		.attr('y', (d: Date) => ((d.getDay() + 6) % 7) * stepY)
		.attr('fill', (d: Date) =>
		{
			const key = dateFormat(d);
			const dayEntry = dailyHeat[key];
			return (dayEntry && dayEntry.heatScore > 0)
				? colorScale(dayEntry.heatScore)
				: '#222222';
		})
		.attr('rx', 2)
		.append('title')
		.text((d: Date) =>
		{
			const key = dateFormat(d);
			const dayEntry = dailyHeat[key];
			if(dayEntry && dayEntry.commitCount > 0)
			{
				return `${key}: ${dayEntry.commitCount} commits, ${dayEntry.linesChanged} lines changed`;
			}
			return `${key}: No Activity`;
		});

	return d3n.svgString();
}

/**
 * Inspects project data, finds all years with active dailyHeat entries,
 * and writes project-data-${projectName}-${year}.svg files
 */
export function generateProjectYearlyHeatmaps(
	projectData: ProjectData,
	outputDir: string
): void
{
	const safeProjectName = projectData.projectName.replace(/[^a-zA-Z0-9_\-]/g, '_');
	const activeYears = new Set<number>();

	for(const [dayKey, dayEntry] of Object.entries(projectData.dailyHeat))
	{
		if(!dayEntry || dayEntry.commitCount === 0) continue;

		const year = parseInt(dayKey.substring(0, 4), 10);
		if(!isNaN(year))
		{
			activeYears.add(year);
		}
	}

	if(activeYears.size === 0)
	{
		console.log(`Skipping SVGs for ${projectData.projectName}: No activity found.`);
		return;
	}

	activeYears.forEach((year) =>
	{
		const svgContent = renderD3HeatmapForYearSVG(projectData.dailyHeat, year);
		const svgFilename = `project-data-${safeProjectName}-${year}.svg`;
		const outputPath = path.join(outputDir, svgFilename);

		fs.writeFileSync(outputPath, svgContent, 'utf-8');
		console.log(`   └─ Generated SVG: ${svgFilename}`);
	});
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
