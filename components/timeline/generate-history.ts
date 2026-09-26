/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createClient } from '@libsql/client';
import * as crypto from 'crypto';
import type { ITimelineItem } from './generate';

export interface ChromeHistoryRow
{
	id: bigint | number;
	url: string;
	title: string;
	visit_count: number;
	typed_count: number;
	last_visit_time: bigint;
	hidden: number;
}

const HOMEPATH = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || '';
const BASE_DATE = new Date(Date.parse("1601-01-01T00:00:00+0000"));

/**
 * Converts WebKit microsecond timestamps (microseconds since Jan 1, 1601 UTC) to standard JS Date
 */
export function chromeTimeToDate(webKitMicroseconds: bigint): Date
{
	const msSince1601 = Number(webKitMicroseconds / 1000n);
	return new Date(BASE_DATE.getTime() + msSince1601);
}

export function findHistoryFile(): string
{
	const workingPaths: string[] = [];
	let settingsPath: string;

	if(os.platform() === 'win32')
	{
		settingsPath = path.join(HOMEPATH, 'AppData/Local');
	} else if(os.platform() === 'darwin')
	{
		settingsPath = path.join(HOMEPATH, 'Library/Application Support');
	} else
	{
		settingsPath = path.join(HOMEPATH, '.config');
	}

	workingPaths.push(path.join(settingsPath, 'Google/Chrome/Default/History'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/Profile 1/History'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/User Data/Default/History'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/User Data/Profile 1/History'));
	workingPaths.push(path.join(settingsPath, 'BraveSoftware/Brave-Browser/Default/History'));

	for(const p of workingPaths)
	{
		if(fs.existsSync(p))
		{
			return p;
		}
	}
	throw new Error(`Couldn't locate Chrome/Brave history file. Checked:\n${workingPaths.join('\n')}`);
}

export async function getHistory(startDate: Date | null = null, endDate: Date | null = null): Promise<ChromeHistoryRow[]>
{
	const historyFile = findHistoryFile();

	// Copy to OS temp directory with a unique filename
	const tempFileName = `chrome-history-${crypto.randomBytes(6).toString('hex')}.sqlite`;
	const tempFilePath = path.join(os.tmpdir(), tempFileName);

	try
	{
		fs.copyFileSync(historyFile, tempFilePath);
	} catch(err: any)
	{
		throw new Error(`Failed to copy Chrome history database: ${err.message}`);
	}

	// Clean file protocol URI without unsupported query parameters
	const fileUrl = process.platform === 'win32'
		? `file:///${tempFilePath.replace(/\\/g, '/')}`
		: `file:${tempFilePath}`;

	const client = createClient({
		url: fileUrl,
		intMode: "bigint"
	});

	let rows: ChromeHistoryRow[] = [];

	try
	{
		let sql = 'SELECT id, url, title, visit_count, typed_count, last_visit_time, hidden FROM urls WHERE 1=1';
		const args: any[] = [];

		if(startDate)
		{
			const startMicroseconds = BigInt((startDate.getTime() - BASE_DATE.getTime()) * 1000);
			sql += ' AND last_visit_time >= ?';
			args.push(startMicroseconds);
		}

		if(endDate)
		{
			const endMicroseconds = BigInt((endDate.getTime() - BASE_DATE.getTime()) * 1000);
			sql += ' AND last_visit_time <= ?';
			args.push(endMicroseconds);
		}

		sql += ' ORDER BY last_visit_time ASC';

		const rs = await client.execute({ sql, args });
		rows = rs.rows as unknown as ChromeHistoryRow[];
	} finally
	{
		// Close the client connection
		client.close();

		// Register exit handler for guaranteed deferred cleanup on Windows
		process.once('exit', () =>
		{
			try
			{
				if(fs.existsSync(tempFilePath))
				{
					fs.unlinkSync(tempFilePath);
				}
			} catch
			{
				// Ignore OS lock delays
			}
		});

		// Attempt immediate non-blocking cleanup
		try
		{
			if(fs.existsSync(tempFilePath))
			{
				fs.unlinkSync(tempFilePath);
			}
		} catch
		{
			// Silently defer to exit handler if Windows holds lock briefly
		}
	}

	return rows;
}

export async function generateHistoryData(startDate: Date | null = null, endDate: Date | null = null): Promise<ITimelineItem[]>
{
	const historyRows = await getHistory(startDate, endDate);

	const EXCLUDED_PATTERNS = [
		/accounts\.google/i,
		/auth\//i,
		/\/sso\//i,
		/mail\.google/i,
	];

	const filtered = historyRows.filter(entry =>
		entry.url &&
		!EXCLUDED_PATTERNS.some(expr => expr.test(entry.url)) &&
		entry.title && entry.title.trim().length > 0
	);

	return filtered.map(entry =>
	{
		let title = entry.title.trim();

		// Extract raw search terms for common engines
		if(title === 'Startpage Search Results' || title === 'Google Search' || title.includes(' - Google Search'))
		{
			const match = (/\?q=([^&]*)/i).exec(entry.url);
			if(match)
			{
				title = 'Search: ' + decodeURIComponent(match[1].replace(/\+/g, ' '));
			}
		}

		const visitDate = chromeTimeToDate(entry.last_visit_time);
		let domain = '';
		try
		{
			domain = new URL(entry.url).hostname;
		} catch
		{
			domain = entry.url;
		}

		return {
			id: `history-${entry.id.toString()}`,
			category: 'history',
			timestamp: visitDate.toISOString(),
			title: title,
			detail: {
				title: title,
				url: entry.url,
				domain: domain,
				visitCount: Number(entry.visit_count || 1),
				typedCount: Number(entry.typed_count || 0),
				timeUsec: entry.last_visit_time.toString()
			}
		};
	});
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

		const startStr = getArg('--start');
		const endStr = getArg('--end');
		const outDirArg = getArg('--out-dir') || __dirname;

		const startDate = startStr ? new Date(startStr) : null;
		const endDate = endStr ? new Date(endStr) : null;

		try
		{
			console.log(`Extracting Chrome/Brave history...`);
			const items = await generateHistoryData(startDate, endDate);

			if(items.length === 0)
			{
				console.log('No history records found matching specified criteria.');
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
				const filePath = path.join(targetDataDir, `history-data-${yearMonth}.json`);
				fs.writeFileSync(filePath, JSON.stringify(monthItems, null, 2), 'utf-8');
				console.log(`  -> Saved ${monthItems.length} items to data/history-data-${yearMonth}.json`);
				totalWritten += monthItems.length;
			});

			console.log(`\nSuccessfully partitioned ${totalWritten} history items across ${Object.keys(groupedByYearMonth).length} monthly files.`);
		} catch(err: any)
		{
			console.error('Execution Error:', err.message);
			process.exit(1);
		}
	})();
}
