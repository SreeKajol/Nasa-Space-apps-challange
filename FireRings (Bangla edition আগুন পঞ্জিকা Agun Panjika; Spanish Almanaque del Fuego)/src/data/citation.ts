/*
 * Data citation and acknowledgements, as the data providers ask for them.
 * Kept in their original English wording (they are formal acknowledgements,
 * not UI copy); the headings around them are translated. Also in README.md.
 */

export interface Citation {
  id: "firms" | "power" | "eonet" | "gibs";
  name: string;
  text: string;
  products?: string[];
  url: string;
}

export const CITATIONS: Citation[] = [
  {
    id: "firms",
    name: "NASA FIRMS",
    text: "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of NASA's Earth Science Data and Information System (ESDIS).",
    products: [
      "MODIS Collection 6.1 active fire / hotspot detections, Terra and Aqua (MCD14ML standard; MCD14DL near-real-time, doi:10.5067/FIRMS/MODIS/MCD14DL.NRT.0061)",
      "VIIRS 375 m active fire detections: Suomi-NPP VNP14IMG (doi:10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002), NOAA-20 VJ114IMG (doi:10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002), NOAA-21 VJ214IMG (doi:10.5067/FIRMS/VIIRS/VJ214IMGT_NRT.002)",
    ],
    url: "https://firms.modaps.eosdis.nasa.gov/",
  },
  {
    id: "power",
    name: "NASA POWER",
    text: "These data were obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program.",
    url: "https://power.larc.nasa.gov/",
  },
  {
    id: "eonet",
    name: "NASA EONET",
    text: "Natural event data from the NASA Earth Observatory Natural Event Tracker (EONET), API v3.",
    url: "https://eonet.gsfc.nasa.gov/",
  },
  {
    id: "gibs",
    name: "NASA GIBS",
    text: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
    url: "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api",
  },
];
