/**
 * Apple Music answers, written by hand in the shapes Apple returns (the APIs
 * were not reachable when these tests were written). Album ids are real;
 * track ids, artwork paths and durations are illustrative. Replace with
 * captured answers when convenient.
 */

const violatorTracks = [
  "World in My Eyes",
  "Sweetest Perfection",
  "Personal Jesus",
  "Halo",
  "Waiting for the Night",
  "Enjoy the Silence",
  "Policy of Truth",
  "Blue Dress",
  "Clean",
];

/** GET /v1/catalog/ch/albums/665404621 */
export const violatorApi = {
  data: [
    {
      id: "665404621",
      type: "albums",
      attributes: {
        name: "Violator",
        artistName: "Depeche Mode",
        releaseDate: "1990-03-19",
        genreNames: ["Alternative", "Music"],
        trackCount: violatorTracks.length,
        url: "https://music.apple.com/ch/album/violator/665404621",
        artwork: {
          width: 1400,
          height: 1400,
          url: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/example/source/{w}x{h}bb.jpg",
        },
      },
      relationships: {
        artists: { data: [{ id: "148662", type: "artists" }] },
        tracks: {
          data: violatorTracks.map((name, i) => ({
            id: String(665404700 + i),
            type: "songs",
            attributes: { name, discNumber: 1, trackNumber: i + 1, durationInMillis: 240000 + i * 1000 },
          })),
        },
      },
    },
  ],
};

/** GET /v1/catalog/ch/songs/665404702?include=albums */
export const personalJesusApi = {
  data: [
    {
      id: "665404702",
      type: "songs",
      attributes: { name: "Personal Jesus" },
      relationships: { albums: { data: [{ id: "665404621", type: "albums" }] } },
    },
  ],
};

/** Kick, with tracks out of order and over two discs, to check sorting. */
export const kickApi = {
  data: [
    {
      id: "1440855131",
      type: "albums",
      attributes: {
        name: "Kick (Remastered)",
        artistName: "INXS",
        releaseDate: "1987-10-19",
        genreNames: ["Rock"],
        trackCount: 3,
        url: "https://music.apple.com/ch/album/kick-remastered/1440855131",
      },
      relationships: {
        tracks: {
          data: [
            { id: "3", type: "songs", attributes: { name: "Bonus", discNumber: 2, trackNumber: 1, durationInMillis: 1000 } },
            { id: "2", type: "songs", attributes: { name: "Need You Tonight", discNumber: 1, trackNumber: 2, durationInMillis: 181000 } },
            { id: "1", type: "songs", attributes: { name: "Guns in the Sky", discNumber: 1, trackNumber: 1, durationInMillis: 142000 } },
          ],
        },
      },
    },
  ],
};

/**
 * music.apple.com album page, reduced to the parts the fallback reads: the
 * schema.org MusicAlbum JSON-LD.
 */
export const violatorPage = `<!DOCTYPE html><html><head>
<title>Violator by Depeche Mode on Apple Music</title>
<script type="application/ld+json" id="schema:music-album">${JSON.stringify({
  "@context": "http://schema.org",
  "@type": "MusicAlbum",
  name: "Violator",
  url: "https://music.apple.com/ch/album/violator/665404621",
  image: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/example/source/1200x630wp.png",
  datePublished: "1990-03-19",
  genre: ["Alternative", "Music"],
  byArtist: [{ "@type": "MusicGroup", name: "Depeche Mode", url: "https://music.apple.com/ch/artist/depeche-mode/148662" }],
  tracks: violatorTracks.map((name, i) => ({
    "@type": "MusicRecording",
    name,
    duration: `PT4M${i}S`,
    url: `https://music.apple.com/ch/song/x/${665404700 + i}`,
  })),
})}</script>
</head><body></body></html>`;

export const personalJesusPage = `<!DOCTYPE html><html><head>
<script type="application/ld+json">${JSON.stringify({
  "@context": "http://schema.org",
  "@type": "MusicRecording",
  name: "Personal Jesus",
  inAlbum: { "@type": "MusicAlbum", name: "Violator", url: "https://music.apple.com/ch/album/violator/665404621" },
})}</script></head><body></body></html>`;
