import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import type { LuminoLayoutWindow } from '../bundle/lumino.d';
import type { ITimelineData, ITimelinePingInternal } from './generate';
import './leaflet.js';

// Declare Leaflet globally
declare const L: any;

const widgetSelf = self as unknown as LuminoLayoutWindow & {
	GPSWidget?: typeof GPSWidget;
};

export interface ITileProviderOption
{
	id: string;
	name: string;
	url: string;
	attribution: string;
	subdomains?: string;
	maxZoom: number;
	default?: boolean;
}

const TILE_PROVIDERS: ITileProviderOption[] = [
	{
		id: 'carto-dark',
		name: 'CARTO Dark Matter (Raster)',
		url: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
		attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>',
		subdomains: 'abcd',
		maxZoom: 20
	},
	{
		id: 'carto-positron',
		name: 'CARTO Positron (Light)',
		url: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png',
		attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>',
		subdomains: 'abcd',
		maxZoom: 20
	},
	{
		id: 'osm-standard',
		name: 'OpenStreetMap (Standard)',
		url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
		attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
		maxZoom: 19,
		default: true
	},
	{
		id: 'osm-fr',
		name: 'OpenStreetMap France',
		url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
		attribution: '&copy; OpenStreetMap France | &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
		maxZoom: 20
	},
	{
		id: 'osm-hot',
		name: 'Humanitarian OSM (HOT)',
		url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
		attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, Tiles by <a href="https://hotosm.org">HOT</a>',
		maxZoom: 19
	},
	{
		id: 'esri-satellite',
		name: 'Esri World Imagery (Satellite)',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
		maxZoom: 18
	},
	{
		id: 'stamen-toner',
		name: 'Stamen Toner Lite (Stadia)',
		url: 'https://tiles.stadiamaps.com/tiles/stamen_toner_lite/{z}/{x}/{y}{r}.png',
		attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://stamen.com/">Stamen Design</a>',
		maxZoom: 20
	}
];

/**
 * Lumino Autonomous GPS Timeline & Leaflet Route Visualizer Widget
 */
export class GPSWidget extends Widget
{
	public static instance: GPSWidget | null = null;

	private _mapContainerEl!: HTMLDivElement;
	private _apiKeyInputEl!: HTMLInputElement;
	private _providerSelectEl!: HTMLSelectElement;
	private _mapInstance: any = null;
	private _currentTileLayer: any = null;
	private _timelineData: ITimelineData = { places: [], lines: [], pings: [] };
	private _googleApiKey: string = '';

	// Metric DOM Element References
	private _waypointsValEl!: HTMLSpanElement;
	private _pathwaysValEl!: HTMLSpanElement;

	constructor()
	{
		super();
		this.addClass('lm-GPSWidget');
		this.id = 'timeline-route-hub-widget';

		this.node.style.overflow = 'hidden';
		this.node.style.display = 'flex';
		this.node.style.flexDirection = 'column';
		this.node.style.height = '100%';
		this.node.style.width = '100%';
		this.node.style.backgroundColor = '#121214';
		this.node.style.color = '#e1e1e6';
		this.node.style.fontFamily = 'Consolas, "Courier New", monospace';

		this.title.label = 'GPS Location';
		this.title.iconClass = 'bx bx-location';
		this.title.closable = true;
	}

	public static getInstance(): GPSWidget
	{
		if(!GPSWidget.instance || GPSWidget.instance.isDisposed)
		{
			GPSWidget.instance = new GPSWidget();
		}
		return GPSWidget.instance;
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		this._buildUI();
		this._initMap();
		this._fetchTimelineData();
	}

	protected onResize(msg: Widget.ResizeMessage): void
	{
		super.onResize(msg);
		if(this._mapInstance)
		{
			setTimeout(() => this._mapInstance.invalidateSize(), 100);
		}
	}

	public dispose(): void
	{
		if(this._mapInstance)
		{
			this._mapInstance.remove();
			this._mapInstance = null;
		}
		GPSWidget.instance = null;
		super.dispose();
	}

	private _buildUI(): void
	{
		this.node.replaceChildren();

		// Control Header
		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.justifyContent = 'space-between';
		header.style.alignItems = 'center';
		header.style.padding = '8px 14px';
		header.style.backgroundColor = '#18181a';
		header.style.borderBottom = '1px solid #2d2d30';

		// Left Box: Title + Styled Metric Badges
		const titleBox = document.createElement('div');
		titleBox.style.display = 'flex';
		titleBox.style.flexDirection = 'column';
		titleBox.style.gap = '6px';

		const metricsRow = document.createElement('div');
		metricsRow.style.display = 'flex';
		metricsRow.style.gap = '8px';
		metricsRow.style.alignItems = 'center';

		metricsRow.appendChild(this._createMetricPill('Log Duration', 'Past 30 Days', '#4ec9b0')?.container);

		const waypointsPill = this._createMetricPill('Waypoints', '0', '#ce9178');
		this._waypointsValEl = waypointsPill.valueSpan;
		metricsRow.appendChild(waypointsPill.container);

		const pathwaysPill = this._createMetricPill('Pathways', '0', '#569cd6');
		this._pathwaysValEl = pathwaysPill.valueSpan;
		metricsRow.appendChild(pathwaysPill.container);

		titleBox.appendChild(metricsRow);

		// Right Box: Provider Select + API Key + Upload Button
		const controlsBox = document.createElement('div');
		controlsBox.style.display = 'none';
		controlsBox.style.alignItems = 'center';
		controlsBox.style.gap = '8px';

		// Provider Dropdown
		this._providerSelectEl = document.createElement('select');
		this._providerSelectEl.style.fontSize = '11px';
		this._providerSelectEl.style.padding = '4px 8px';
		this._providerSelectEl.style.backgroundColor = '#252526';
		this._providerSelectEl.style.color = '#00f2fe';
		this._providerSelectEl.style.border = '1px solid #3c3c3c';
		this._providerSelectEl.style.borderRadius = '3px';
		this._providerSelectEl.style.cursor = 'pointer';

		TILE_PROVIDERS.forEach((prov) =>
		{
			const opt = document.createElement('option');
			if(prov.default === true)
			{
				opt.selected = true;
			}
			opt.value = prov.id;
			opt.textContent = prov.name;
			this._providerSelectEl.appendChild(opt);
		});

		this._providerSelectEl.onchange = () =>
		{
			this._switchTileProvider(this._providerSelectEl.value);
		};

		// API Key Input
		this._apiKeyInputEl = document.createElement('input');
		this._apiKeyInputEl.type = 'password';
		this._apiKeyInputEl.placeholder = 'Google Places API Key...';
		this._apiKeyInputEl.style.fontSize = '11px';
		this._apiKeyInputEl.style.padding = '4px 8px';
		this._apiKeyInputEl.style.backgroundColor = '#252526';
		this._apiKeyInputEl.style.color = '#e1e1e6';
		this._apiKeyInputEl.style.border = '1px solid #3c3c3c';
		this._apiKeyInputEl.style.borderRadius = '3px';
		this._apiKeyInputEl.style.width = '180px';

		this._apiKeyInputEl.value = localStorage.getItem('google_places_api_key') || '';
		this._apiKeyInputEl.onchange = () =>
		{
			this._googleApiKey = this._apiKeyInputEl.value.trim();
			localStorage.setItem('google_places_api_key', this._googleApiKey);
		};

		// Upload Button
		const uploadBtn = document.createElement('button');
		uploadBtn.className = 'tab-btn';
		uploadBtn.style.padding = '4px 10px';
		uploadBtn.style.fontSize = '11px';
		uploadBtn.style.cursor = 'pointer';
		uploadBtn.innerHTML = '<i class="bx bx-upload"></i> Load JSON';

		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = '.json';
		fileInput.style.display = 'none';

		uploadBtn.onclick = () => fileInput.click();
		fileInput.onchange = (e: Event) =>
		{
			const target = e.target as HTMLInputElement;
			if(target.files && target.files[0])
			{
				this._parseUploadedFile(target.files[0]);
			}
		};

		controlsBox.appendChild(this._providerSelectEl);
		controlsBox.appendChild(this._apiKeyInputEl);
		controlsBox.appendChild(uploadBtn);
		controlsBox.appendChild(fileInput);

		header.appendChild(titleBox);
		header.appendChild(controlsBox);

		// Map Render Container
		this._mapContainerEl = document.createElement('div');
		this._mapContainerEl.style.flex = '1';
		this._mapContainerEl.style.width = '100%';
		this._mapContainerEl.style.height = '100%';

		this.node.appendChild(header);
		this.node.appendChild(this._mapContainerEl);
	}

	private _createMetricPill(
		label: string,
		initialValue: string,
		accentColor: string
	): { container: HTMLDivElement; valueSpan: HTMLSpanElement; }
	{
		const container = document.createElement('div');
		container.style.display = 'inline-flex';
		container.style.alignItems = 'center';
		container.style.gap = '6px';
		container.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
		container.style.border = '1px solid rgba(255, 255, 255, 0.08)';
		container.style.borderRadius = '4px';
		container.style.padding = '2px 8px';
		container.style.fontSize = '11px';

		const labelSpan = document.createElement('span');
		labelSpan.style.color = '#888';
		labelSpan.textContent = label + ':';

		const valueSpan = document.createElement('span');
		valueSpan.style.color = accentColor;
		valueSpan.style.fontWeight = 'bold';
		valueSpan.textContent = initialValue;

		container.appendChild(labelSpan);
		container.appendChild(valueSpan);

		return { container, valueSpan };
	}

	private _initMap(): void
	{
		if(!this._mapContainerEl || this._mapInstance) return;

		this._mapInstance = L.map(this._mapContainerEl, { zoomSnap: 0.5 }).setView([35.1983, -111.6513], 11);
		const defaultProv = TILE_PROVIDERS.find(p => p.default === true)?.id ?? 'carto-dark';
		this._switchTileProvider(defaultProv);
	}

	private _switchTileProvider(providerId: string): void
	{
		if(!this._mapInstance) return;

		const provider = TILE_PROVIDERS.find((p) => p.id === providerId) || TILE_PROVIDERS[0];

		if(this._currentTileLayer)
		{
			this._mapInstance.removeLayer(this._currentTileLayer);
		}

		const options: any = {
			attribution: provider.attribution,
			maxZoom: provider.maxZoom,
			crossOrigin: 'anonymous'
		};

		if(provider.subdomains)
		{
			options.subdomains = provider.subdomains;
		}

		this._currentTileLayer = L.tileLayer(provider.url, options).addTo(this._mapInstance);
	}

	private async _fetchTimelineData(): Promise<void>
	{
		try
		{
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 15000);

			const response = await fetch('/components/gps/timeline-data.json', { signal: controller.signal });
			clearTimeout(timeoutId);

			if(response.ok)
			{
				this._timelineData = await response.json();
			} else if((window as any).TIMELINE_DATA)
			{
				this._timelineData = (window as any).TIMELINE_DATA;
			}
		} catch
		{
			if((window as any).TIMELINE_DATA)
			{
				this._timelineData = (window as any).TIMELINE_DATA;
			}
		} finally
		{
			this._updateMetricsUI();
			this._renderMapLayers();
		}
	}

	private async _parseUploadedFile(file: File): Promise<void>
	{
		const text = await file.text();
		try
		{
			const json = JSON.parse(text);
			this._timelineData = this._processRawTimelineJson(json);
			this._updateMetricsUI();
			this._renderMapLayers();
		} catch(err)
		{
			console.error('Failed to parse uploaded Timeline JSON:', err);
		}
	}

	private _updateMetricsUI(): void
	{
		if(this._waypointsValEl)
		{
			this._waypointsValEl.textContent = (this._timelineData.pings?.length || 0).toLocaleString();
		}
		if(this._pathwaysValEl)
		{
			this._pathwaysValEl.textContent = (this._timelineData.lines?.length || 0).toLocaleString();
		}
	}

	private _processRawTimelineJson(rawData: any): ITimelineData
	{
		const now = new Date();
		const oneMonthAgo = new Date();
		oneMonthAgo.setDate(now.getDate() - 30);

		const result: ITimelineData = { places: [], lines: [], pings: [] };
		const allPings: ITimelinePingInternal[] = [];

		const extractCoords = (obj: any) =>
		{
			if(!obj || typeof obj !== 'object') return null;
			if(typeof obj.LatLng === 'string')
			{
				const matches = obj.LatLng.match(/(-?\d+\.\d+)/g);
				if(matches && matches.length >= 2) return { lat: parseFloat(matches[0]), lng: parseFloat(matches[1]) };
			}
			if(typeof obj.latitudeE7 === 'number' && typeof obj.longitudeE7 === 'number')
			{
				return { lat: obj.latitudeE7 / 1e7, lng: obj.longitudeE7 / 1e7 };
			}
			const latVal = obj.lat ?? obj.latitude;
			const lngVal = obj.lng ?? obj.longitude;
			if(typeof latVal === 'number' && typeof lngVal === 'number') return { lat: latVal, lng: lngVal };
			return null;
		};

		const walk = (node: any) =>
		{
			if(!node || typeof node !== 'object') return;
			const coords = extractCoords(node);
			if(coords)
			{
				const time = new Date(node.timestamp || node.startTime || node.time || Date.now());
				if(!isNaN(time.getTime()) && time >= oneMonthAgo)
				{
					allPings.push({ lat: coords.lat, lng: coords.lng, time });
				}
			}
			if(Array.isArray(node))
			{
				node.forEach((item) => walk(item));
			} else
			{
				Object.keys(node).forEach((key) => walk(node[key]));
			}
		};

		walk(rawData);
		allPings.sort((a, b) => a.time.getTime() - b.time.getTime());
		result.pings = allPings.map((p) => [p.lat, p.lng]);

		let currentSegment: number[][] = [];
		for(let i = 0; i < allPings.length; i++)
		{
			const ping = allPings[i];
			if(currentSegment.length === 0)
			{
				currentSegment.push([ping.lat, ping.lng]);
				continue;
			}
			const prevPing = allPings[i - 1];
			const gapMinutes = (ping.time.getTime() - prevPing.time.getTime()) / (1000 * 60);

			if(gapMinutes > 30)
			{
				if(currentSegment.length > 1) result.lines.push(currentSegment);
				currentSegment = [[ping.lat, ping.lng]];
			} else
			{
				currentSegment.push([ping.lat, ping.lng]);
			}
		}
		if(currentSegment.length > 1) result.lines.push(currentSegment);

		return result;
	}

	private async _renderMapLayers(): Promise<void>
	{
		if(!this._mapInstance) return;

		const bounds: number[][] = [];

		// 1. Raw Pings
		if(Array.isArray(this._timelineData.pings))
		{
			this._timelineData.pings.forEach((ping) =>
			{
				L.circleMarker(ping, {
					radius: 2,
					fillColor: '#00f2fe',
					color: '#00f2fe',
					weight: 0,
					fillOpacity: 0.4,
					interactive: false
				}).addTo(this._mapInstance);
				bounds.push(ping);
			});
		}

		// 2. Lines & OSRM Routing
		if(Array.isArray(this._timelineData.lines))
		{
			for(const line of this._timelineData.lines)
			{
				if(line.length < 2) continue;

				const roadGeometry = (await this._fetchRoadRoute(line)) || line;

				L.polyline(roadGeometry, {
					color: '#00f2fe',
					weight: 3.5,
					opacity: 0.75,
					lineCap: 'round',
					lineJoin: 'round',
					interactive: false
				}).addTo(this._mapInstance);

				// Add Directional Arrow Markers
				const step = Math.max(1, Math.floor(roadGeometry.length / 8));
				for(let i = 0; i < roadGeometry.length - 1; i += step)
				{
					const p1 = roadGeometry[i];
					const p2 = roadGeometry[i + 1];

					const dy = p2[0] - p1[0];
					const dx = Math.cos((Math.PI / 180) * p1[0]) * (p2[1] - p1[1]);
					const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

					const arrowSvg = `
                        <svg width="14" height="14" viewBox="0 0 24 24" style="transform: rotate(${90 - angle}deg); display: block;">
                            <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" fill="#00f2fe" stroke="#000000" stroke-width="1.5"/>
                        </svg>
                    `;

					const arrowIcon = L.divIcon({
						className: 'direction-arrow-icon',
						html: arrowSvg,
						iconSize: [14, 14],
						iconAnchor: [7, 7]
					});

					L.marker([p1[0], p1[1]], { icon: arrowIcon, interactive: false }).addTo(this._mapInstance);
				}
			}
		}

		// 3. Places
		if(Array.isArray(this._timelineData.places))
		{
			this._timelineData.places.forEach((place) =>
			{
				if(place.lat && place.lng)
				{
					const placeColor = this._getColorForPlace(place.name);

					const marker = L.circleMarker([place.lat, place.lng], {
						radius: 7,
						fillColor: placeColor,
						color: '#ffffff',
						weight: 2,
						opacity: 1,
						fillOpacity: 0.95
					});

					marker.bindPopup(`
                        <div style="font-family: sans-serif; padding: 2px;">
                            <div style="font-weight: bold; font-size: 14px; color: ${placeColor};">${place.name}</div>
                            <div style="font-size: 11px; color: #888; margin-top: 4px;">${place.time}</div>
                        </div>
                    `);

					marker.on('mouseover', function (this: any)
					{
						this.setRadius(10);
						this.bringToFront();
					});
					marker.on('mouseout', function (this: any)
					{
						this.setRadius(7);
					});

					marker.addTo(this._mapInstance);
					bounds.push([place.lat, place.lng]);
				}
			});
		}

		if(bounds.length > 0)
		{
			this._mapInstance.fitBounds(bounds, { padding: [30, 30] });
		}
	}

	private async _fetchRoadRoute(coords: number[][]): Promise<number[][] | null>
	{
		if(coords.length < 2) return null;

		let sampled = coords;
		if(coords.length > 80)
		{
			const step = Math.ceil(coords.length / 80);
			sampled = coords.filter((_, idx) => idx % step === 0);
			if(sampled[sampled.length - 1] !== coords[coords.length - 1])
			{
				sampled.push(coords[coords.length - 1]);
			}
		}

		const coordString = sampled.map((c) => `${c[1]},${c[0]}`).join(';');
		const url = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;

		try
		{
			const response = await fetch(url);
			if(!response.ok) return null;
			const data = await response.json();
			if(data.routes && data.routes.length > 0)
			{
				return data.routes[0].geometry.coordinates.map((c: number[]) => [c[1], c[0]]);
			}
		} catch
		{
			// OSRM fallback
		}
		return null;
	}

	private _getColorForPlace(name: string): string
	{
		let hash = 0;
		const str = name || 'Unknown Place';
		for(let i = 0; i < str.length; i++)
		{
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		const hue = Math.abs(hash) % 360;
		return `hsl(${hue}, 85%, 60%)`;
	}
}

widgetSelf.GPSWidget = GPSWidget;
