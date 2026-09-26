import * as fs from 'fs';
import * as path from 'path';
import type { IEmploymentEntry } from '../resume/widget';
import type { ProjectsDataRegistry } from '../projects/generate';

export interface ITimelineItem
{
	id: string;
	category: 'commits' | 'bookmarks' | 'history' | 'locations' | 'events';
	timestamp: string; // ISO String
	title: string;
	detail: any | string;    // JSON string payload
}

interface IResumeData
{
	employment_history?: IEmploymentEntry[];
	[key: string]: any;
}

const DATA_DIR = path.join(__dirname, 'data');
const RESUME_FILE = path.join(__dirname, 'resume.json');

/**
 * Ensures target data output folder exists
 */
function ensureDataDirectory(): void
{
	if(!fs.existsSync(DATA_DIR))
	{
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

/**
 * Maps resume.json employment milestones to ITimelineItem events
 */
function loadResumeItems(): ITimelineItem[]
{
	if(!fs.existsSync(RESUME_FILE)) return [];

	try
	{
		const rawResume: IResumeData = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf-8'));
		if(!rawResume.employment_history) return [];

		const items: ITimelineItem[] = [];

		rawResume.employment_history.forEach((emp, idx) =>
		{
			// Parse initial start year from period strings (e.g., "Aug 2019 - Present" -> 2019-08-01, "2024 - 2026" -> 2024-01-01)
			let year = 2024;
			let month = 1;

			const yearMatch = emp.period.match(/\b(20\d\d|19\d\d)\b/);
			if(yearMatch)
			{
				year = parseInt(yearMatch[1], 10);
			}

			const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
			months.forEach((m, mIdx) =>
			{
				if(emp.period.toLowerCase().includes(m))
				{
					month = mIdx + 1;
				}
			});

			const startDate = new Date(year, month - 1, 1, 9, 0, 0);

			items.push({
				id: `resume-emp-${idx}`,
				category: 'events',
				timestamp: startDate.toISOString(),
				title: `Role Milestone: ${emp.role} at ${emp.company}`,
				detail: {
					role: emp.role,
					company: emp.company,
					period: emp.period,
					location: emp.location,
					narrative: emp.narrative,
					highlights: emp.highlights,
					skills: emp.related_skills
				}
			});
		});

		return items;
	} catch(err: any)
	{
		console.warn(`[Aggregate] Skipping resume.json parsing: ${err.message}`);
		return [];
	}
}

/**
 * Reads project-data-$year-$month.json files and converts commits into single-line ITimelineItem records
 */
function loadProjectDataItems(yearMonth: string): ITimelineItem[]
{
	const filePath = path.join(__dirname, `project-data-${yearMonth}.json`);
	const altPath = path.join(DATA_DIR, `project-data-${yearMonth}.json`);

	let targetPath = fs.existsSync(filePath) ? filePath : (fs.existsSync(altPath) ? altPath : null);
	if(!targetPath) return [];

	const items: ITimelineItem[] = [];

	try
	{
		const rawData: ProjectsDataRegistry = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
		if(!rawData.projects) return items;

		Object.values(rawData.projects).forEach(proj =>
		{
			if(!proj.dailyHeat) return;

			Object.values(proj.dailyHeat).forEach(heat =>
			{
				if(!heat?.commits) return;

				heat.commits.forEach(commit =>
				{
					const filesCount = commit.filesChanged ? commit.filesChanged.length : 0;
					const otherFiles = filesCount > 2 ? ` and ${filesCount - 2} more files` : '';
					const topFiles = (commit.filesChanged || []).slice(0, 2).join(', ');

					const summaryTitle = `[${proj.projectName}] ${commit.message.split('\n')[0]} (${topFiles}${otherFiles})`;

					items.push({
						id: `commit-${commit.hash}`,
						category: 'commits',
						timestamp: commit.date,
						title: summaryTitle,
						detail: {
							project: proj.projectName,
							hash: commit.hash,
							author: commit.author,
							linesAdded: commit.linesAdded,
							linesDeleted: commit.linesDeleted,
							filesChanged: commit.filesChanged,
							fullMessage: commit.message
						}
					});
				});
			});
		});
	} catch(err: any)
	{
		console.warn(`[Aggregate] Skipping project file ${yearMonth}: ${err.message}`);
	}

	return items;
}

/**
 * Reads specific category JSON file from data directory
 */
function loadCategoryItems(prefix: string, yearMonth: string): ITimelineItem[]
{
	const filePath = path.join(DATA_DIR, `${prefix}-data-${yearMonth}.json`);
	if(!fs.existsSync(filePath)) return [];

	try
	{
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch
	{
		return [];
	}
}

/**
 * Loads yearly bookmarks file and filters entries matching yearMonth
 */
function loadBookmarkItemsForMonth(yearMonth: string): ITimelineItem[]
{
	const [yearStr, monthStr] = yearMonth.split('-');
	const filePath = path.join(__dirname, `bookmarks-data-${yearStr}.json`);
	const altPath = path.join(DATA_DIR, `bookmarks-data-${yearStr}.json`);

	const targetPath = fs.existsSync(filePath) ? filePath : (fs.existsSync(altPath) ? altPath : null);
	if(!targetPath) return [];

	try
	{
		const rawBookmarks: ITimelineItem[] = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
		return rawBookmarks.filter(item =>
		{
			const d = new Date(item.timestamp);
			const itemMonth = (d.getMonth() + 1).toString().padStart(2, '0');
			return itemMonth === monthStr;
		});
	} catch
	{
		return [];
	}
}

/**
 * Main Master Aggregator: Scans directories to identify all available YYYY-MM bounds and compiles timeline-$year-$month.json
 */
export async function buildMasterTimeline(): Promise<void>
{
	ensureDataDirectory();

	console.log('[+] Discovering dataset boundaries across project, history, location, event, and bookmark files...');

	const yearMonths = new Set<string>();

	// 1. Scan directory for project-data-YYYY-MM.json
	const rootFiles = fs.readdirSync(__dirname);
	rootFiles.forEach(file =>
	{
		const projMatch = file.match(/^project-data-(\d{4}-\d{2})\.json$/);
		if(projMatch) yearMonths.add(projMatch[1]);

		const bmMatch = file.match(/^bookmarks-data-(\d{4})\.json$/);
		if(bmMatch)
		{
			// Add all 12 months for this year
			for(let m = 1; m <= 12; m++)
			{
				yearMonths.add(`${bmMatch[1]}-${m.toString().padStart(2, '0')}`);
			}
		}
	});

	// 2. Scan data directory for events, history, locations
	if(fs.existsSync(DATA_DIR))
	{
		const dataFiles = fs.readdirSync(DATA_DIR);
		dataFiles.forEach(file =>
		{
			const match = file.match(/^(events|history|locations)-data-(\d{4}-\d{2})\.json$/);
			if(match) yearMonths.add(match[2]);
		});
	}

	const sortedYearMonths = Array.from(yearMonths).sort();
	console.log(`[+] Found ${sortedYearMonths.length} unique month windows to generate.`);

	const resumeItems = loadResumeItems();

	let totalItemsCombined = 0;

	for(const ym of sortedYearMonths)
	{
		const [yearStr, monthStr] = ym.split('-');
		const year = parseInt(yearStr, 10);
		const month = parseInt(monthStr, 10);

		const combined: ITimelineItem[] = [];

		// Combine category layers
		combined.push(...loadProjectDataItems(ym));
		combined.push(...loadCategoryItems('events', ym));
		combined.push(...loadCategoryItems('history', ym));
		combined.push(...loadCategoryItems('locations', ym));
		combined.push(...loadBookmarkItemsForMonth(ym));

		// Filter resume items occurring in this month
		const matchingResume = resumeItems.filter(item =>
		{
			const d = new Date(item.timestamp);
			return d.getFullYear() === year && (d.getMonth() + 1) === month;
		});
		combined.push(...matchingResume);

		if(combined.length === 0) continue;

		// Deduplicate and sort chronologically
		const seenIds = new Set<string>();
		const deduplicated: ITimelineItem[] = [];

		combined.forEach(item =>
		{
			if(!seenIds.has(item.id))
			{
				seenIds.add(item.id);
				deduplicated.push(item);
			}
		});

		deduplicated.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

		// Write final output file
		const masterPath = path.join(DATA_DIR, `timeline-${ym}.json`);
		fs.writeFileSync(masterPath, JSON.stringify(deduplicated, null, 2), 'utf-8');

		console.log(`  -> Compiled data/timeline-${ym}.json (${deduplicated.length} items)`);
		totalItemsCombined += deduplicated.length;
	}

	console.log(`\n[+] Successfully generated ${totalItemsCombined} timeline items across data/timeline-$year-$month.json files!`);
}

// CLI Execution Entrypoint
if(require.main === module)
{
	(async () =>
	{
		try
		{
			await buildMasterTimeline();
		} catch(err: any)
		{
			console.error('Execution Error:', err.message);
			process.exit(1);
		}
	})();
}
