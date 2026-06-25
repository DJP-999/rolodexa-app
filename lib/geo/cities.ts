// Built-in city gazetteer for mapping the rolodex without any geocoding API.
// City-center coordinates for major US metros + global financial hubs, plus US-state
// and country centroids as fallbacks. Keys are lowercased city names; ambiguous names
// resolve to the finance-relevant city. Good enough for road-show planning.

export type GeoHit = { lat: number; lng: number; label: string };

type City = { lat: number; lng: number; label: string; aliases?: string[] };

const CITIES: Record<string, City> = {
  // --- US: Northeast ---
  "new york": { lat: 40.7128, lng: -74.006, label: "New York, NY", aliases: ["nyc", "manhattan", "new york city"] },
  brooklyn: { lat: 40.6782, lng: -73.9442, label: "Brooklyn, NY" },
  greenwich: { lat: 41.0262, lng: -73.6282, label: "Greenwich, CT" },
  stamford: { lat: 41.0534, lng: -73.5387, label: "Stamford, CT" },
  boston: { lat: 42.3601, lng: -71.0589, label: "Boston, MA" },
  cambridge: { lat: 42.3736, lng: -71.1097, label: "Cambridge, MA" },
  philadelphia: { lat: 39.9526, lng: -75.1652, label: "Philadelphia, PA", aliases: ["philly"] },
  "washington": { lat: 38.9072, lng: -77.0369, label: "Washington, DC", aliases: ["washington dc", "dc", "d.c."] },
  pittsburgh: { lat: 40.4406, lng: -79.9959, label: "Pittsburgh, PA" },
  // --- US: Southeast ---
  miami: { lat: 25.7617, lng: -80.1918, label: "Miami, FL" },
  "miami beach": { lat: 25.7907, lng: -80.13, label: "Miami Beach, FL" },
  "west palm beach": { lat: 26.7153, lng: -80.0534, label: "West Palm Beach, FL" },
  "palm beach": { lat: 26.7056, lng: -80.0364, label: "Palm Beach, FL" },
  orlando: { lat: 28.5383, lng: -81.3792, label: "Orlando, FL" },
  tampa: { lat: 27.9506, lng: -82.4572, label: "Tampa, FL" },
  atlanta: { lat: 33.749, lng: -84.388, label: "Atlanta, GA" },
  charlotte: { lat: 35.2271, lng: -80.8431, label: "Charlotte, NC" },
  raleigh: { lat: 35.7796, lng: -78.6382, label: "Raleigh, NC" },
  nashville: { lat: 36.1627, lng: -86.7816, label: "Nashville, TN" },
  // --- US: Midwest ---
  chicago: { lat: 41.8781, lng: -87.6298, label: "Chicago, IL" },
  minneapolis: { lat: 44.9778, lng: -93.265, label: "Minneapolis, MN" },
  detroit: { lat: 42.3314, lng: -83.0458, label: "Detroit, MI" },
  columbus: { lat: 39.9612, lng: -82.9988, label: "Columbus, OH" },
  cleveland: { lat: 41.4993, lng: -81.6944, label: "Cleveland, OH" },
  // --- US: South Central ---
  austin: { lat: 30.2672, lng: -97.7431, label: "Austin, TX" },
  dallas: { lat: 32.7767, lng: -96.797, label: "Dallas, TX" },
  houston: { lat: 29.7604, lng: -95.3698, label: "Houston, TX" },
  "fort worth": { lat: 32.7555, lng: -97.3308, label: "Fort Worth, TX" },
  // --- US: Mountain / West ---
  denver: { lat: 39.7392, lng: -104.9903, label: "Denver, CO" },
  "salt lake city": { lat: 40.7608, lng: -111.891, label: "Salt Lake City, UT" },
  phoenix: { lat: 33.4484, lng: -112.074, label: "Phoenix, AZ" },
  scottsdale: { lat: 33.4942, lng: -111.9261, label: "Scottsdale, AZ" },
  "las vegas": { lat: 36.1699, lng: -115.1398, label: "Las Vegas, NV" },
  // --- US: West Coast ---
  "san francisco": { lat: 37.7749, lng: -122.4194, label: "San Francisco, CA", aliases: ["sf"] },
  "palo alto": { lat: 37.4419, lng: -122.143, label: "Palo Alto, CA" },
  "menlo park": { lat: 37.453, lng: -122.182, label: "Menlo Park, CA" },
  "mountain view": { lat: 37.3861, lng: -122.0839, label: "Mountain View, CA" },
  "san jose": { lat: 37.3382, lng: -121.8863, label: "San Jose, CA" },
  "san mateo": { lat: 37.563, lng: -122.3255, label: "San Mateo, CA" },
  oakland: { lat: 37.8044, lng: -122.2712, label: "Oakland, CA" },
  berkeley: { lat: 37.8715, lng: -122.273, label: "Berkeley, CA" },
  "los angeles": { lat: 34.0522, lng: -118.2437, label: "Los Angeles, CA", aliases: ["la", "l.a."] },
  "santa monica": { lat: 34.0195, lng: -118.4912, label: "Santa Monica, CA" },
  "san diego": { lat: 32.7157, lng: -117.1611, label: "San Diego, CA" },
  seattle: { lat: 47.6062, lng: -122.3321, label: "Seattle, WA" },
  bellevue: { lat: 47.6101, lng: -122.2015, label: "Bellevue, WA" },
  portland: { lat: 45.5152, lng: -122.6784, label: "Portland, OR" },
  // --- Canada ---
  toronto: { lat: 43.6532, lng: -79.3832, label: "Toronto, ON" },
  vancouver: { lat: 49.2827, lng: -123.1207, label: "Vancouver, BC" },
  montreal: { lat: 45.5019, lng: -73.5674, label: "Montreal, QC" },
  calgary: { lat: 51.0447, lng: -114.0719, label: "Calgary, AB" },
  ottawa: { lat: 45.4215, lng: -75.6972, label: "Ottawa, ON" },
  // --- Europe ---
  london: { lat: 51.5074, lng: -0.1278, label: "London, UK" },
  paris: { lat: 48.8566, lng: 2.3522, label: "Paris, France" },
  frankfurt: { lat: 50.1109, lng: 8.6821, label: "Frankfurt, Germany" },
  berlin: { lat: 52.52, lng: 13.405, label: "Berlin, Germany" },
  munich: { lat: 48.1351, lng: 11.582, label: "Munich, Germany" },
  zurich: { lat: 47.3769, lng: 8.5417, label: "Zurich, Switzerland" },
  geneva: { lat: 46.2044, lng: 6.1432, label: "Geneva, Switzerland" },
  amsterdam: { lat: 52.3676, lng: 4.9041, label: "Amsterdam, Netherlands" },
  madrid: { lat: 40.4168, lng: -3.7038, label: "Madrid, Spain" },
  barcelona: { lat: 41.3851, lng: 2.1734, label: "Barcelona, Spain" },
  milan: { lat: 45.4642, lng: 9.19, label: "Milan, Italy" },
  stockholm: { lat: 59.3293, lng: 18.0686, label: "Stockholm, Sweden" },
  dublin: { lat: 53.3498, lng: -6.2603, label: "Dublin, Ireland" },
  lisbon: { lat: 38.7223, lng: -9.1393, label: "Lisbon, Portugal" },
  luxembourg: { lat: 49.6116, lng: 6.1319, label: "Luxembourg" },
  // --- Middle East / Africa ---
  dubai: { lat: 25.2048, lng: 55.2708, label: "Dubai, UAE" },
  "abu dhabi": { lat: 24.4539, lng: 54.3773, label: "Abu Dhabi, UAE" },
  "tel aviv": { lat: 32.0853, lng: 34.7818, label: "Tel Aviv, Israel" },
  riyadh: { lat: 24.7136, lng: 46.6753, label: "Riyadh, Saudi Arabia" },
  doha: { lat: 25.2854, lng: 51.531, label: "Doha, Qatar" },
  // --- Asia / Pacific ---
  singapore: { lat: 1.3521, lng: 103.8198, label: "Singapore" },
  "hong kong": { lat: 22.3193, lng: 114.1694, label: "Hong Kong" },
  tokyo: { lat: 35.6762, lng: 139.6503, label: "Tokyo, Japan" },
  shanghai: { lat: 31.2304, lng: 121.4737, label: "Shanghai, China" },
  beijing: { lat: 39.9042, lng: 116.4074, label: "Beijing, China" },
  shenzhen: { lat: 22.5431, lng: 114.0579, label: "Shenzhen, China" },
  seoul: { lat: 37.5665, lng: 126.978, label: "Seoul, South Korea" },
  mumbai: { lat: 19.076, lng: 72.8777, label: "Mumbai, India" },
  bangalore: { lat: 12.9716, lng: 77.5946, label: "Bangalore, India", aliases: ["bengaluru"] },
  sydney: { lat: -33.8688, lng: 151.2093, label: "Sydney, Australia" },
  melbourne: { lat: -37.8136, lng: 144.9631, label: "Melbourne, Australia" },
  // --- Latin America ---
  "sao paulo": { lat: -23.5505, lng: -46.6333, label: "São Paulo, Brazil", aliases: ["são paulo"] },
  "mexico city": { lat: 19.4326, lng: -99.1332, label: "Mexico City, Mexico" },
  "buenos aires": { lat: -34.6037, lng: -58.3816, label: "Buenos Aires, Argentina" },
};

// US state centroids (fallback when only a state is given).
const STATES: Record<string, GeoHit> = {
  ca: { lat: 36.7783, lng: -119.4179, label: "California" },
  ny: { lat: 42.9, lng: -75.5, label: "New York" },
  tx: { lat: 31.0, lng: -99.0, label: "Texas" },
  fl: { lat: 27.8, lng: -81.7, label: "Florida" },
  il: { lat: 40.0, lng: -89.0, label: "Illinois" },
  ma: { lat: 42.3, lng: -71.8, label: "Massachusetts" },
  ct: { lat: 41.6, lng: -72.7, label: "Connecticut" },
  wa: { lat: 47.4, lng: -120.5, label: "Washington" },
  co: { lat: 39.0, lng: -105.5, label: "Colorado" },
  ga: { lat: 32.6, lng: -83.4, label: "Georgia" },
  nc: { lat: 35.6, lng: -79.4, label: "North Carolina" },
  nj: { lat: 40.1, lng: -74.7, label: "New Jersey" },
  pa: { lat: 41.2, lng: -77.2, label: "Pennsylvania" },
  az: { lat: 34.2, lng: -111.7, label: "Arizona" },
  tn: { lat: 35.9, lng: -86.4, label: "Tennessee" },
  ut: { lat: 39.3, lng: -111.7, label: "Utah" },
};

// Country centroids (fallback when only a country is given).
const COUNTRIES: Record<string, GeoHit> = {
  usa: { lat: 39.8, lng: -98.6, label: "United States" },
  "united states": { lat: 39.8, lng: -98.6, label: "United States" },
  uk: { lat: 54.0, lng: -2.0, label: "United Kingdom" },
  "united kingdom": { lat: 54.0, lng: -2.0, label: "United Kingdom" },
  england: { lat: 52.4, lng: -1.5, label: "England" },
  canada: { lat: 56.1, lng: -106.3, label: "Canada" },
  germany: { lat: 51.2, lng: 10.4, label: "Germany" },
  france: { lat: 46.6, lng: 2.2, label: "France" },
  switzerland: { lat: 46.8, lng: 8.2, label: "Switzerland" },
  india: { lat: 20.6, lng: 78.9, label: "India" },
  china: { lat: 35.9, lng: 104.2, label: "China" },
  japan: { lat: 36.2, lng: 138.3, label: "Japan" },
  australia: { lat: -25.3, lng: 133.8, label: "Australia" },
  israel: { lat: 31.0, lng: 34.9, label: "Israel" },
  uae: { lat: 23.4, lng: 53.8, label: "United Arab Emirates" },
  singapore: { lat: 1.3521, lng: 103.8198, label: "Singapore" },
  brazil: { lat: -14.2, lng: -51.9, label: "Brazil" },
  mexico: { lat: 23.6, lng: -102.5, label: "Mexico" },
};

// Build an alias → key lookup once.
const ALIAS: Record<string, string> = {};
for (const [key, c] of Object.entries(CITIES)) {
  ALIAS[key] = key;
  for (const a of c.aliases ?? []) ALIAS[a] = key;
}

function clean(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a free-text location to coordinates, or null if we can't place it. */
export function geocode(raw?: string | null): GeoHit | null {
  if (!raw) return null;
  const s = clean(raw);
  if (!s) return null;

  // Whole-string city match (e.g. "singapore", "hong kong").
  if (ALIAS[s]) return CITIES[ALIAS[s]];

  const parts = s.split(/[,/|]/).map((p) => clean(p)).filter(Boolean);
  const city = parts[0] ?? "";

  // City (first segment) match.
  if (ALIAS[city]) return CITIES[ALIAS[city]];

  // Try each segment as a city (handles "Suite 200, Palo Alto, CA").
  for (const p of parts) if (ALIAS[p]) return CITIES[ALIAS[p]];

  // Region fallback: a US state abbrev or a country in any trailing segment.
  for (const p of parts.slice(1).reverse()) {
    if (STATES[p]) return STATES[p];
    if (COUNTRIES[p]) return COUNTRIES[p];
  }
  // Last resort: the whole string as a country.
  if (COUNTRIES[s]) return COUNTRIES[s];
  return null;
}
