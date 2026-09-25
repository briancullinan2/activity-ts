/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ITimelineItem } from './generate';

export interface ChromeBookmarkNode
{
	id: string;
	name: string;
	type: 'folder' | 'url';
	url?: string;
	date_added?: string | number;
	children?: ChromeBookmarkNode[];
}

export interface RawBookmark
{
	id: string;
	name: string;
	url: string;
	folder: string;
	time_usec: number;
	date: Date;
}

const HOMEPATH = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || '';

/**
 * Converts Chrome microsecond timestamps to standard JS Date
 */
export function chromeDtToDate(microsec: number): Date
{
	// Chrome epoch starts Jan 1, 1601 (11644473600 seconds before Unix epoch)
	const microsecondsPerMillisecond = 1000;
	const epochOffsetMs = 11644473600000;
	const msSinceUnixEpoch = Math.floor(microsec / microsecondsPerMillisecond) - epochOffsetMs;
	return new Date(msSinceUnixEpoch);
}

/**
 * Dummy placeholder for decryptFile if custom profile encryption is needed
 */
export function decryptFile(data: string): string
{
	return data;
}

export function findBookmarksFile(): string
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

	workingPaths.push(path.join(settingsPath, 'Google/Chrome/Default/Bookmarks'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/Profile 1/Bookmarks'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/User Data/Default/Bookmarks'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/User Data/Profile 1/Bookmarks'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/User Data/Default/AccountBookmarks'));
	workingPaths.push(path.join(settingsPath, 'Google/Chrome/User Data/Profile 1/AccountBookmarks'));
	workingPaths.push(path.join(settingsPath, 'BraveSoftware/Brave-Browser/Default/Bookmarks'));

	for(const p of workingPaths)
	{
		if(fs.existsSync(p))
		{
			return p;
		}
	}
	throw new Error(`Couldn't locate Chrome/Brave bookmarks file. Checked:\n${workingPaths.join('\n')}`);
}

export function decryptBookmarks(): string
{
	const bookmarksFile = findBookmarksFile();
	const bookmarksData = fs.readFileSync(bookmarksFile, 'utf-8');

	if(bookmarksData.trim().startsWith('{'))
	{
		return bookmarksData;
	}
	return decryptFile(bookmarksData);
}

export function parseBookmarks(): RawBookmark[]
{
	const parsedJson = JSON.parse(decryptBookmarks());
	const roots = parsedJson.roots || {};
	let rootNodes: ChromeBookmarkNode[] = [];

	if(roots.bookmark_bar && roots.bookmark_bar.children)
	{
		rootNodes = rootNodes.concat(roots.bookmark_bar.children);
	}
	if(roots.other && roots.other.children)
	{
		rootNodes = rootNodes.concat(roots.other.children);
	}
	if(roots.synced && roots.synced.children)
	{
		rootNodes = rootNodes.concat(roots.synced.children);
	}

	const recursiveGroup = (folderPath: string, list: RawBookmark[], node: ChromeBookmarkNode): RawBookmark[] =>
	{
		let currentFolder = folderPath;
		if(currentFolder.includes('Other Bookmarks'))
		{
			currentFolder = '';
		}

		if(node.type === 'folder')
		{
			currentFolder += (currentFolder && currentFolder.length > 0 ? '/' : '') + node.name;
			if(node.children)
			{
				node.children.forEach(child => recursiveGroup(currentFolder, list, child));
			}
		} else if(node.type === 'url' && node.url)
		{
			const timeUsec = parseInt(String(node.date_added || 0), 10);
			list.push({
				id: node.id || `bm-${timeUsec}-${Math.random().toString(36).substring(2, 7)}`,
				name: node.name,
				url: node.url,
				folder: currentFolder,
				time_usec: timeUsec,
				date: chromeDtToDate(timeUsec)
			});
		}
		return list;
	};

	const bookmarks: RawBookmark[] = [];
	rootNodes.forEach(node => recursiveGroup('', bookmarks, node));
	return bookmarks;
}

export function generateBookmarksData(startDate: Date | null = null, endDate: Date | null = null): ITimelineItem[]
{
	const rawBookmarks = parseBookmarks();

	// 1. Filter elements strictly by date window parameters (if supplied)
	const filtered = rawBookmarks.filter(book =>
	{
		if(isNaN(book.date.getTime())) return false;
		if(startDate && book.date < startDate) return false;
		if(endDate && book.date > endDate) return false;
		return true;
	});

	// 2. Sort chronologically (newest first)
	filtered.sort((a, b) => b.date.getTime() - a.date.getTime());

	// 3. Map into full ITimelineItem vis.js interface without truncation
	return filtered.map(book =>
	{
		const lastFolderName = book.folder ? path.basename(book.folder) : 'Root';
		const folderPrefix = book.folder ? `[${lastFolderName}] ` : '';

		return {
			id: `bookmark-${book.id}`,
			category: 'bookmarks',
			timestamp: book.date.toISOString(),
			title: `${folderPrefix}${book.name}`,
			detail: {
				name: book.name,
				url: book.url,
				folderPath: book.folder,
				lastFolder: lastFolderName,
				timeUsec: book.time_usec
			}
		};
	});
}


// CLI Execution Support
if(require.main === module)
{
	(() =>
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
			console.log(`Extracting Chrome/Brave bookmarks...`);
			const items = generateBookmarksData(startDate, endDate);

			if(items.length === 0)
			{
				console.log('No bookmarks found matching specified criteria.');
				return;
			}

			// Group bookmarks by ISO year extracted from timestamp
			const groupedByYear = items.reduce((acc, item) =>
			{
				const year = new Date(item.timestamp).getFullYear().toString();
				if(!acc[year])
				{
					acc[year] = [];
				}
				acc[year].push(item);
				return acc;
			}, {} as Record<string, ITimelineItem[]>);

			if(!fs.existsSync(outDirArg))
			{
				fs.mkdirSync(outDirArg, { recursive: true });
			}

			let totalWritten = 0;
			Object.entries(groupedByYear).forEach(([year, yearItems]) =>
			{
				const filePath = path.join(outDirArg, 'data', `bookmarks-data-${year}.json`);
				fs.writeFileSync(filePath, JSON.stringify(yearItems, null, 2), 'utf-8');
				console.log(`  -> Saved ${yearItems.length} items to bookmarks-data-${year}.json`);
				totalWritten += yearItems.length;
			});

			console.log(`\nSuccessfully partitioned ${totalWritten} bookmarks across ${Object.keys(groupedByYear).length} yearly files.`);
		} catch(err: any)
		{
			console.error('Execution Error:', err.message);
			process.exit(1);
		}
	})();
}
