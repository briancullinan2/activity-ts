/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export interface ITimelinePlace
{
	name: string;
	lat: number;
	lng: number;
	time: string;
}

export interface ITimelinePingInternal
{
	lat: number;
	lng: number;
	time: Date;
}

export interface ITimelineData
{
	places: ITimelinePlace[];
	lines: number[][][];
	pings: number[][];
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
const DATA_JSON_FILE = path.join(__dirname, 'timeline-data.json');
const DATA_JS_FILE = path.join(__dirname, 'timeline-data.js');

let GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
const credentialsPath = path.join(USER_HOME, '.credentials', 'places.txt');
if(fs.existsSync(credentialsPath))
{
	GOOGLE_API_KEY = fs.readFileSync(credentialsPath, 'utf8').trim();
}

/**
 * Finds the most recently modified timeline JSON file in the user's Downloads directory.
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

/**
 * Reads existing places directly from timeline-data.json or timeline-data.js for location caching
 */
function loadExistingData(): ITimelineData | null
{
	if(fs.existsSync(DATA_JSON_FILE))
	{
		try
		{
			return JSON.parse(fs.readFileSync(DATA_JSON_FILE, 'utf8'));
		} catch(_) { }
	}

	if(fs.existsSync(DATA_JS_FILE))
	{
		try
		{
			const content = fs.readFileSync(DATA_JS_FILE, 'utf8');
			const jsonMatch = content.match(/self\.TIMELINE_DATA\s*=\s*([\s\S]+?);?$/);
			if(jsonMatch && jsonMatch[1])
			{
				return JSON.parse(jsonMatch[1]);
			}
		} catch(_) { }
	}
	return null;
}

function findInExistingPlaces(
	lat: number,
	lng: number,
	existingPlaces: ITimelinePlace[],
	radiusMeters = 50
): string | null
{
	if(!existingPlaces) return null;
	const radiusKm = radiusMeters / 1000;

	for(const place of existingPlaces)
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
						return resolve(tags.name || tags.brand || null);
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

async function resolveBusinessName(
	lat: number,
	lng: number,
	existingPlaces: ITimelinePlace[]
): Promise<string | null>
{
	const cachedName = findInExistingPlaces(lat, lng, existingPlaces);
	if(cachedName) return cachedName;

	let name = await lookupBusinessOSM(lat, lng);
	if(!name && GOOGLE_API_KEY)
	{
		name = await lookupBusinessGoogle(lat, lng);
	}
	return name;
}

function findStops(
	allPings: ITimelinePingInternal[],
	minStopMinutes = 5,
	maxRadiusKm = 0.08
): IDetectedStop[]
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

/**
 * Main Async Parser: Parses raw timeline JSON file into `ITimelineData` payload
 */
export async function parseTimelineDataAsync(filePath: string): Promise<ITimelineData>
{
	console.log(`[+] Parsing file: ${filePath}`);
	const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

	const existingData = loadExistingData();
	const existingPlaces = existingData ? existingData.places : [];

	const mapData: ITimelineData = { places: [], lines: [], pings: [] };
	const allPings: ITimelinePingInternal[] = [];

	function parseDate(val: any): Date | null
	{
		if(!val) return null;
		if(typeof val === 'number')
		{
			return new Date(val);
		}
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

	// Step 1: Extract all valid coordinates and timestamps regardless of age
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
				mapData.places.push({
					name: candidate.semanticType || candidate.name || 'Visited Place',
					lat: coords.lat,
					lng: coords.lng,
					time: time.toLocaleString()
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
		console.warn('[-] No coordinates extracted from timeline JSON.');
		return mapData;
	}

	allPings.sort((a, b) => a.time.getTime() - b.time.getTime());

	// Step 2: Determine date boundary (Filter to 30 days relative to newest waypoint in dataset)
	const newestTimestamp = allPings[allPings.length - 1].time;
	const filterBoundary = new Date(newestTimestamp);
	filterBoundary.setDate(filterBoundary.getDate() - 30);

	const activePings = allPings.filter(p => p.time >= filterBoundary);
	mapData.pings = activePings.map((p) => [p.lat, p.lng]);

	// Build line segments
	let currentSegment: number[][] = [];
	for(let i = 0; i < activePings.length; i++)
	{
		const ping = activePings[i];
		if(currentSegment.length === 0)
		{
			currentSegment.push([ping.lat, ping.lng]);
			continue;
		}

		const prevPing = activePings[i - 1];
		const gapMinutes = (ping.time.getTime() - prevPing.time.getTime()) / (1000 * 60);

		if(gapMinutes > 30)
		{
			if(currentSegment.length > 1) mapData.lines.push(currentSegment);
			currentSegment = [[ping.lat, ping.lng]];
		} else
		{
			const lastCoord = currentSegment[currentSegment.length - 1];
			if(lastCoord[0] !== ping.lat || lastCoord[1] !== ping.lng)
			{
				currentSegment.push([ping.lat, ping.lng]);
			}
		}
	}
	if(currentSegment.length > 1) mapData.lines.push(currentSegment);

	// Identify stationary stops
	const detectedStops = findStops(activePings, 5, 0.08);
	const totalStops = detectedStops.length;

	console.log(`[+] Loaded ${activePings.length} waypoints (Window: ${filterBoundary.toISOString().slice(0, 10)} to ${newestTimestamp.toISOString().slice(0, 10)})`);
	console.log(`[+] Resolving ${totalStops} stationary stops against ${existingPlaces.length} cached places...`);

	let lastLoggedPercent = -1;
	for(let i = 0; i < totalStops; i++)
	{
		const stop = detectedStops[i];
		const businessName = await resolveBusinessName(stop.lat, stop.lng, existingPlaces);

		const placeObj: ITimelinePlace = {
			name: businessName ? businessName : `Stopped (${stop.durationMins} mins)`,
			lat: stop.lat,
			lng: stop.lng,
			time: stop.startTime.toLocaleString()
		};

		mapData.places.push(placeObj);

		// Keep cache array updated dynamically so identical stops in current run hit cache
		if(businessName && !findInExistingPlaces(stop.lat, stop.lng, existingPlaces))
		{
			existingPlaces.push(placeObj);
		}

		const currentPercent = Math.floor(((i + 1) / totalStops) * 100);
		if(currentPercent > lastLoggedPercent)
		{
			console.log(`[+] Business Resolution: ${currentPercent}% (${i + 1}/${totalStops})`);
			lastLoggedPercent = currentPercent;
		}
	}

	// Persist outputs
	//if(!fs.existsSync(DOCS_DIR))
	//{
	//	fs.mkdirSync(DOCS_DIR, { recursive: true });
	//}

	fs.writeFileSync(DATA_JSON_FILE, JSON.stringify(mapData, null, 2), 'utf8');
	fs.writeFileSync(DATA_JS_FILE, `self.TIMELINE_DATA = ${JSON.stringify(mapData, null, 2)};\n`, 'utf8');

	console.log(`[+] Saved payload to ${DATA_JSON_FILE} and ${DATA_JS_FILE}`);
	return mapData;
}

// CLI Execution Entry Point
if(require.main === module)
{
	(async () =>
	{
		const targetFile = findLatestTimelineFile();
		if(!targetFile)
		{
			console.error('[-] No timeline JSON file found in Downloads folder.');
			process.exit(1);
		}
		await parseTimelineDataAsync(targetFile);
	})();
}
