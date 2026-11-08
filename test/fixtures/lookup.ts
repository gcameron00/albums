/**
 * Lookup API answers in the shape itunes.apple.com/lookup returns. Written by
 * hand (the API was not reachable when these tests were written), so ids
 * other than the album ids, artwork paths and durations are illustrative.
 * Replace with captured answers when convenient.
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

export const violator = {
  resultCount: 1 + violatorTracks.length,
  results: [
    {
      wrapperType: "collection",
      collectionType: "Album",
      artistId: 148662,
      collectionId: 665404621,
      artistName: "Depeche Mode",
      collectionName: "Violator",
      collectionViewUrl: "https://music.apple.com/ch/album/violator/665404621?uo=4",
      artworkUrl60: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/example/source/60x60bb.jpg",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/example/source/100x100bb.jpg",
      trackCount: violatorTracks.length,
      country: "CHE",
      currency: "CHF",
      releaseDate: "1990-03-19T08:00:00Z",
      primaryGenreName: "Alternative",
    },
    ...violatorTracks.map((trackName, i) => ({
      wrapperType: "track",
      kind: "song",
      artistId: 148662,
      collectionId: 665404621,
      trackId: 665404700 + i,
      artistName: "Depeche Mode",
      collectionName: "Violator",
      trackName,
      discNumber: 1,
      trackNumber: i + 1,
      trackTimeMillis: 240000 + i * 1000,
    })),
  ],
};

/** id=<Personal Jesus track id> without entity=song. */
export const personalJesusSong = {
  resultCount: 1,
  results: [violator.results[3]],
};

export const kick = {
  resultCount: 3,
  results: [
    {
      wrapperType: "collection",
      collectionType: "Album",
      artistId: 129814,
      collectionId: 1440855131,
      artistName: "INXS",
      collectionName: "Kick (Remastered)",
      collectionViewUrl: "https://music.apple.com/ch/album/kick-remastered/1440855131?uo=4",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/dd/ee/ff/example/source/100x100bb.jpg",
      trackCount: 2,
      releaseDate: "1987-10-19T07:00:00Z",
      primaryGenreName: "Rock",
    },
    // Out of order and with a second disc, to check sorting.
    { wrapperType: "track", kind: "song", collectionId: 1440855131, trackName: "Need You Tonight", discNumber: 1, trackNumber: 2, trackTimeMillis: 181000 },
    { wrapperType: "track", kind: "song", collectionId: 1440855131, trackName: "Guns in the Sky", discNumber: 1, trackNumber: 1, trackTimeMillis: 142000 },
  ],
};

export const empty = { resultCount: 0, results: [] };
