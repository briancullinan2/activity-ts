/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import * as ical from 'node-ical';
import type { ITimelineItem } from './generate';


const HOMEPATH = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || '';

const CALENDAR_NAMES = [
	'Diet', 'Emotions', 'General', 'Iga',
	'Predictions', 'Revelation', 'Robot do'
];

const PUBLIC_CALENDARS = [
	'Diet', 'General', 'Revelation', 'Robot do', 'Predictions'
];

/**
 * Finds the latest Google Takeout Calendar directory inside Downloads
 */
export function findLatestTakeoutCalendarDir(): string | null
{
	const downloadsDir = path.join(HOMEPATH, 'Downloads');
	if(!fs.existsSync(downloadsDir)) return null;

	const takeouts = fs.readdirSync(downloadsDir)
		.filter(dir =>
		{
			return dir && dir.startsWith('Takeout')
				&& fs.existsSync(path.join(downloadsDir, dir, 'Calendar'));
		})
		.map(dir => path.join(downloadsDir, dir, 'Calendar'));

	if(takeouts.length === 0) return null;

	takeouts.sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());
	return takeouts[0];
}

/**
 * Parses all ICS exports and formats events into ITimelineItem records
 */
export async function generateEventsData(calendarDir?: string): Promise<ITimelineItem[]>
{
	const targetDir = calendarDir || findLatestTakeoutCalendarDir();
	if(!targetDir || !fs.existsSync(targetDir))
	{
		throw new Error(`Couldn't locate Takeout Calendar directory. Checked Downloads folder.`);
	}

	console.log(`[+] Reading ICS files from: ${targetDir}`);

	const calendarFiles = fs.readdirSync(targetDir)
		.filter(fname =>
		{
			return CALENDAR_NAMES.some(icalName => fname.startsWith(icalName) && fname.endsWith('.ics'));
		})
		.map(fname => path.join(targetDir, fname));

	if(calendarFiles.length === 0)
	{
		console.warn('[-] No matching .ics calendar files located.');
		return [];
	}

	const timelineItems: ITimelineItem[] = [];

	for(let i = 0; i < calendarFiles.length; i++)
	{
		const filePath = calendarFiles[i];
		if(!fs.existsSync(filePath)) continue;

		const publicName = path.basename(filePath).trim().replace(/(_.*)?\.ics$/ig, '');
		const isPublic = PUBLIC_CALENDARS.includes(publicName);

		try
		{
			const parsedData = ical.sync.parseFile(filePath);
			const events = Object.values(parsedData);

			events.forEach((event: any) =>
			{
				if(event.type !== 'VEVENT') return;

				const startDate = event.start instanceof Date ? event.start : new Date(event.start);
				if(!startDate || isNaN(startDate.getTime())) return;

				const endDate = event.end instanceof Date ? event.end : (event.end ? new Date(event.end) : null);

				let displayTitle = '';
				let displayDescription = '';

				if(isPublic)
				{
					displayTitle = event.summary || publicName;
					displayDescription = event.description || '';
				} else
				{
					displayTitle = publicName;
					displayDescription = 'Private Calendar Event';
				}

				const cleanTitle = `[${publicName}] ${displayTitle}`.trim();

				timelineItems.push({
					id: `event-${event.uid || Math.random().toString(36).substring(2, 9)}`,
					category: 'events',
					timestamp: startDate.toISOString(),
					title: cleanTitle,
					detail: {
						calendar: publicName,
						summary: displayTitle,
						description: displayDescription,
						location: event.location || '',
						start: startDate.toISOString(),
						end: endDate ? endDate.toISOString() : null,
						isPublic: isPublic
					}
				});
			});
		} catch(err: any)
		{
			console.warn(`[-] Failed parsing ${filePath}: ${err.message}`);
		}
	}

	// Sort chronologically across all timelines
	timelineItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
	return timelineItems;
}

// CLI Execution Support
if(require.main === module)
{
	(async () =>
	{
		const getArg = (flag: string): string | null =>
		{
			const index = process.argv.indexOf(flag);
			return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
		};

		const dirArg = getArg('--dir');
		const outDirArg = getArg('--out-dir') || __dirname;

		try
		{
			console.log(`Extracting Google Calendar event streams...`);
			const items = await generateEventsData(dirArg || undefined);

			if(items.length === 0)
			{
				console.log('No calendar event records found.');
				return;
			}

			// Partition items into yearly-monthly buckets (YYYY-MM)
			const groupedByYearMonth = items.reduce((acc, item) =>
			{
				const d = new Date(item.timestamp);
				const year = d.getFullYear().toString();
				const month = (d.getMonth() + 1).toString().padStart(2, '0');
				const key = `${year}-${month}`;

				if(!acc[key])
				{
					acc[key] = [];
				}
				acc[key].push(item);
				return acc;
			}, {} as Record<string, ITimelineItem[]>);

			const targetDataDir = path.join(outDirArg, 'data');
			if(!fs.existsSync(targetDataDir))
			{
				fs.mkdirSync(targetDataDir, { recursive: true });
			}

			let totalWritten = 0;
			Object.entries(groupedByYearMonth).forEach(([yearMonth, monthItems]) =>
			{
				const filePath = path.join(targetDataDir, `events-data-${yearMonth}.json`);
				fs.writeFileSync(filePath, JSON.stringify(monthItems, null, 2), 'utf-8');
				console.log(`  -> Saved ${monthItems.length} items to data/events-data-${yearMonth}.json`);
				totalWritten += monthItems.length;
			});

			console.log(`\nSuccessfully partitioned ${totalWritten} calendar events across ${Object.keys(groupedByYearMonth).length} monthly files.`);
		} catch(err: any)
		{
			console.error('Execution Error:', err.message);
			process.exit(1);
		}
	})();
}
