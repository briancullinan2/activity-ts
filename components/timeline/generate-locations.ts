import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { ITimelineItem } from './generate';

export interface ITimelinePingInternal
{
	lat: number;
	lng: number;
	time: Date;
}

export interface ITimelinePlaceCache
{
	name: string;
	lat: number;
	lng: number;
}

interface IDetectedStop
{
	lat: number;
	lng: number;
	durationMins: number;
	startTime: Date;
}

const USER_HOME = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || '';
const DOWNLOADS_DIR = path.join(USER_HOME, 'Downloads');
const CACHE_JSON_FILE = path.join(__dirname, '..', 'gps', 'timeline-data.json');

let GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
const credentialsPath = path.join(USER_HOME, '.credentials', 'places.txt');
if(fs.existsSync(credentialsPath))
{
	GOOGLE_API_KEY = fs.readFileSync(credentialsPath, 'utf8').trim();
}

/**
 * Finds the most recently modified Google Location/Timeline JSON export in Downloads.
 */
export function findLatestTimelineFile(): string | null
{
	if(!fs.existsSync(DOWNLOADS_DIR)) return null;

	const files = fs.readdirSync(DOWNLOADS_DIR);
	const timelineFiles = files.filter(f =>
		f.toLowerCase().includes('timeline') && f.endsWith('.json')
	);

	if(timelineFiles.length === 0) return null;

	const sorted = timelineFiles
		.map(name =>
		{
			const filePath = path.join(DOWNLOADS_DIR, name);
			return { path: filePath, mtime: fs.statSync(filePath).mtime };
		})
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

	return sorted[0].path;
}

function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number
{
	const R = 6371;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos((lat1 * Math.PI) / 180) *
		Math.cos((lat2 * Math.PI) / 180) *
		Math.sin(dLon / 2) *
		Math.sin(dLon / 2);
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function loadPlaceCache(): ITimelinePlaceCache[]
{
	const cacheMap = new Map<string, ITimelinePlaceCache>();

	// Helper to insert items into cacheMap while avoiding duplicates and raw coordinate titles
	const addCacheEntry = (name: string, lat: number, lng: number) =>
	{
		if(!name || !lat || !lng) return;
		// Skip fallback coordinate titles (e.g. "35.2096, -111.5851")
		if(/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(name.trim())) return;
		if(name.startsWith('Stopped (')) return;

		const cleanName = name.replace(/^Visited:\s*/, '').trim();
		// Use coordinate proximity key (~11m resolution) for fast deduplication
		const geoKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;

		if(!cacheMap.has(geoKey))
		{
			cacheMap.set(geoKey, { name: cleanName, lat, lng });
		}
	};

	// 1. Read legacy timeline-data.json / timeline-data.js if present
	if(fs.existsSync(CACHE_JSON_FILE))
	{
		try
		{
			const data = JSON.parse(fs.readFileSync(CACHE_JSON_FILE, 'utf8'));
			if(data && Array.isArray(data.places))
			{
				data.places.forEach((p: any) => addCacheEntry(p.name, p.lat, p.lng));
			}
		} catch(_) { }
	}

	// 2. Glob and parse all generated data/locations-data-*.json files
	const targetDataDir = path.join(__dirname, 'data');
	if(fs.existsSync(targetDataDir))
	{
		try
		{
			const files = fs.readdirSync(targetDataDir);
			const locationFiles = files.filter(f => f.startsWith('locations-data-') && f.endsWith('.json'));

			for(const file of locationFiles)
			{
				const filePath = path.join(targetDataDir, file);
				try
				{
					const rawItems: ITimelineItem[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
					for(const item of rawItems)
					{
						if(!item.detail) continue;
						try
						{
							const detailObj = JSON.parse(item.detail);
							const locName = detailObj.name || detailObj.destination;
							if(locName && detailObj.lat && detailObj.lng)
							{
								addCacheEntry(locName, detailObj.lat, detailObj.lng);
							}
						} catch(_) { }
					}
				} catch(_) { }
			}
		} catch(_) { }
	}

	const loadedPlaces = Array.from(cacheMap.values());
	console.log(`[+] Rebuilt place cache with ${loadedPlaces.length} unique locations.`);
	return loadedPlaces;
}

function findInCache(lat: number, lng: number, cache: ITimelinePlaceCache[], radiusMeters = 50): string | null
{
	const radiusKm = radiusMeters / 1000;
	for(const place of cache)
	{
		if(place.lat && place.lng && place.name)
		{
			const dist = getDistanceKm(lat, lng, place.lat, place.lng);
			if(dist <= radiusKm && !place.name.startsWith('Stopped ('))
			{
				return place.name.replace(/^Visited:\s*/, '');
			}
		}
	}
	return null;
}

function lookupBusinessOSM(lat: number, lng: number, radiusMeters = 50): Promise<string | null>
{
	return new Promise((resolve) =>
	{
		const query = `[out:json][timeout:5];(node(around:${radiusMeters},${lat},${lng})["name"];way(around:${radiusMeters},${lat},${lng})["name"];);out center 1;`;
		const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

		console.log('Loading: ' + url);
		const req = https.get(url, { headers: { 'User-Agent': 'TimelineParser/1.0' } }, (res) =>
		{
			let body = '';
			res.on('data', chunk => (body += chunk));
			res.on('end', () =>
			{
				try
				{
					const data = JSON.parse(body);
					if(data.elements && data.elements.length > 0)
					{
						const tags = data.elements[0].tags || {};
						return resolve(tags.name || tags.brand || tags["addr:street"] || null);
					}
				} catch(_) { }
				resolve(null);
			});
		});

		req.on('error', () => resolve(null));
		req.setTimeout(5000, () =>
		{
			req.destroy();
			resolve(null);
		});
	});
}

function lookupBusinessGoogle(lat: number, lng: number, radiusMeters = 50): Promise<string | null>
{
	return new Promise((resolve) =>
	{
		if(!GOOGLE_API_KEY) return resolve(null);

		const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusMeters}&key=${GOOGLE_API_KEY}`;
		console.log('Loading: ' + url);
		const req = https.get(url, (res) =>
		{
			let body = '';
			res.on('data', chunk => (body += chunk));
			res.on('end', () =>
			{
				try
				{
					const data = JSON.parse(body);
					if(data.results && data.results.length > 0)
					{
						return resolve(data.results[0].name || null);
					}
				} catch(_) { }
				resolve(null);
			});
		});

		req.on('error', () => resolve(null));
		req.setTimeout(5000, () =>
		{
			req.destroy();
			resolve(null);
		});
	});
}

async function resolveLocationName(lat: number, lng: number, cache: ITimelinePlaceCache[]): Promise<string | null>
{
	const cached = findInCache(lat, lng, cache);
	if(cached) return cached;

	let name = await lookupBusinessOSM(lat, lng);
	if(!name && GOOGLE_API_KEY)
	{
		name = await lookupBusinessGoogle(lat, lng);
	}
	return name;
}

function findStops(allPings: ITimelinePingInternal[], minStopMinutes = 5, maxRadiusKm = 0.08): IDetectedStop[]
{
	const stops: IDetectedStop[] = [];
	if(!allPings || allPings.length === 0) return stops;

	let i = 0;
	while(i < allPings.length)
	{
		let j = i + 1;
		let sumLat = allPings[i].lat;
		let sumLng = allPings[i].lng;
		let count = 1;

		while(j < allPings.length)
		{
			const currentCenterLat = sumLat / count;
			const currentCenterLng = sumLng / count;
			const dist = getDistanceKm(currentCenterLat, currentCenterLng, allPings[j].lat, allPings[j].lng);

			if(dist <= maxRadiusKm)
			{
				sumLat += allPings[j].lat;
				sumLng += allPings[j].lng;
				count++;
				j++;
			} else
			{
				break;
			}
		}

		const durationMins = (allPings[j - 1].time.getTime() - allPings[i].time.getTime()) / (1000 * 60);

		if(durationMins >= minStopMinutes)
		{
			stops.push({
				lat: sumLat / count,
				lng: sumLng / count,
				durationMins: Math.round(durationMins),
				startTime: allPings[i].time
			});
			i = j;
		} else
		{
			i++;
		}
	}
	return stops;
}

export async function generateLocationData(filePath: string): Promise<ITimelineItem[]>
{
	console.log(`[+] Parsing source location file: ${filePath}`);
	const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

	const cache = loadPlaceCache();
	const allPings: ITimelinePingInternal[] = [];
	const rawSemanticPlaces: Array<{ name: string; lat: number; lng: number; time: Date; }> = [];

	function parseDate(val: any): Date | null
	{
		if(!val) return null;
		if(typeof val === 'number') return new Date(val);
		const d = new Date(val);
		return isNaN(d.getTime()) ? null : d;
	}

	function extractCoords(obj: any): { lat: number; lng: number; } | null
	{
		if(!obj || typeof obj !== 'object') return null;

		if(typeof obj.LatLng === 'string')
		{
			const matches = obj.LatLng.match(/(-?\d+\.\d+)/g);
			if(matches && matches.length >= 2)
			{
				return { lat: parseFloat(matches[0]), lng: parseFloat(matches[1]) };
			}
		}
		if(typeof obj.point === 'string' && obj.point.startsWith('geo:'))
		{
			const parts = obj.point.replace('geo:', '').split(',');
			if(parts.length >= 2)
			{
				return { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
			}
		}
		if(typeof obj.latitudeE7 === 'number' && typeof obj.longitudeE7 === 'number')
		{
			return { lat: obj.latitudeE7 / 1e7, lng: obj.longitudeE7 / 1e7 };
		}
		const latVal = obj.lat ?? obj.latitude;
		const lngVal = obj.lng ?? obj.longitude;
		if(typeof latVal === 'number' && typeof lngVal === 'number')
		{
			return { lat: latVal, lng: lngVal };
		}
		return null;
	}

	function walk(node: any): void
	{
		if(!node || typeof node !== 'object') return;

		if(node.visit && node.visit.topCandidate)
		{
			const candidate = node.visit.topCandidate;
			const coords = extractCoords(candidate.placeLocation) || extractCoords(candidate.location);
			const time = parseDate(node.startTime || node.visit.startTime);

			if(coords && time)
			{
				rawSemanticPlaces.push({
					name: candidate.semanticType || candidate.name || 'Visited Place',
					lat: coords.lat,
					lng: coords.lng,
					time
				});
			}
		}

		const coords = extractCoords(node);
		if(coords)
		{
			const time = parseDate(node.timestamp || node.startTime || node.time || node.deliveryTime || node.startTimestampMs);
			if(time)
			{
				allPings.push({ lat: coords.lat, lng: coords.lng, time });
			}
		}

		if(Array.isArray(node))
		{
			for(let i = 0; i < node.length; i++) walk(node[i]);
		} else
		{
			for(const key in node)
			{
				if(Object.prototype.hasOwnProperty.call(node, key)) walk(node[key]);
			}
		}
	}

	walk(rawData);

	if(allPings.length === 0)
	{
		console.warn('[-] No coordinate pings extracted.');
		return [];
	}

	// Sort chronologically across the full untruncated timeline
	allPings.sort((a, b) => a.time.getTime() - b.time.getTime());

	const detectedStops = findStops(allPings, 5, 0.08);
	console.log(`[+] Extracted ${allPings.length} raw pings across timeline.`);
	console.log(`[+] Detected ${detectedStops.length} stationary stops. Resolving business/location names...`);

	const items: ITimelineItem[] = [];

	// 1. Process "Stopped at" location entries
	for(let i = 0; i < detectedStops.length; i++)
	{
		const stop = detectedStops[i];
		const resolvedName = await resolveLocationName(stop.lat, stop.lng, cache);
		const name = resolvedName || `${stop.lat.toFixed(4)}, ${stop.lng.toFixed(4)}`;

		// Seed local cache array for future iterations
		if(resolvedName && !findInCache(stop.lat, stop.lng, cache))
		{
			cache.push({ name: resolvedName, lat: stop.lat, lng: stop.lng });
		}

		const title = `Stopped at ${name} (${stop.durationMins} mins)`;
		items.push({
			id: `loc-stop-${stop.startTime.getTime()}-${i}`,
			category: 'locations',
			timestamp: stop.startTime.toISOString(),
			title: title,
			detail: {
				type: 'stop',
				name: name,
				lat: stop.lat,
				lng: stop.lng,
				durationMins: stop.durationMins,
				time: stop.startTime.toISOString()
			}
		});
	}

	// 2. Process "Traveled to" transit segment waypoints (Significant movement entries)
	let lastPoint: ITimelinePingInternal | null = null;
	for(let i = 0; i < allPings.length; i += 15)
	{ // Downsample high-density waypoints for readable travel logs
		const ping = allPings[i];
		if(lastPoint)
		{
			const distKm = getDistanceKm(lastPoint.lat, lastPoint.lng, ping.lat, ping.lng);
			if(distKm >= 1.5)
			{ // Log travel hops greater than 1.5 km
				const resolvedName = await resolveLocationName(ping.lat, ping.lng, cache);
				const destinationName = resolvedName || `${ping.lat.toFixed(4)}, ${ping.lng.toFixed(4)}`;

				items.push({
					id: `loc-travel-${ping.time.getTime()}-${i}`,
					category: 'locations',
					timestamp: ping.time.toISOString(),
					title: `Traveled to ${destinationName}`,
					detail: {
						type: 'travel',
						destination: destinationName,
						lat: ping.lat,
						lng: ping.lng,
						distanceKmFromLast: parseFloat(distKm.toFixed(2)),
						time: ping.time.toISOString()
					}
				});
				lastPoint = ping;
			}
		} else
		{
			lastPoint = ping;
		}
	}

	// Sort final items list chronologically
	items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
	return items;
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

		const fileArg = getArg('--file') || findLatestTimelineFile();
		const outDirArg = getArg('--out-dir') || __dirname;

		if(!fileArg || !fs.existsSync(fileArg))
		{
			console.error('[-] Error: Could not locate timeline JSON file.');
			process.exit(1);
		}

		try
		{
			const items = await generateLocationData(fileArg);

			if(items.length === 0)
			{
				console.log('No location entries generated.');
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
				const filePath = path.join(targetDataDir, `locations-data-${yearMonth}.json`);
				fs.writeFileSync(filePath, JSON.stringify(monthItems, null, 2), 'utf-8');
				console.log(`  -> Saved ${monthItems.length} items to data/locations-data-${yearMonth}.json`);
				totalWritten += monthItems.length;
			});

			console.log(`\nSuccessfully partitioned ${totalWritten} location events across ${Object.keys(groupedByYearMonth).length} monthly files.`);
		} catch(err: any)
		{
			console.error('Execution Error:', err.message);
			process.exit(1);
		}
	})();
}
