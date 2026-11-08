import { describe, expect, it } from "vitest";
import { LinkError, parseAppleMusicLink, parseLookup } from "../src/apple.ts";
import { kick, violator } from "./fixtures/lookup.ts";

describe("parseAppleMusicLink", () => {
  it("reads the example album links", () => {
    expect(parseAppleMusicLink("https://music.apple.com/ch/album/violator/665404621?l=en-GB")).toEqual({
      type: "album",
      id: "665404621",
    });
    expect(parseAppleMusicLink("https://music.apple.com/ch/album/kick-remastered/1440855131?l=en-GB")).toEqual({
      type: "album",
      id: "1440855131",
    });
    expect(parseAppleMusicLink("https://music.apple.com/ch/album/hopes-and-fears/1440798025?l=en-GB")).toEqual({
      type: "album",
      id: "1440798025",
    });
  });

  it("keeps the album id when the link points at a track", () => {
    expect(parseAppleMusicLink("https://music.apple.com/gb/album/violator/665404621?i=665404702")).toEqual({
      type: "album",
      id: "665404621",
      trackId: "665404702",
    });
  });

  it("reads song links, other hosts and links inside text", () => {
    expect(parseAppleMusicLink("https://music.apple.com/ch/song/personal-jesus/665404702")).toEqual({
      type: "song",
      id: "665404702",
    });
    expect(parseAppleMusicLink("https://itunes.apple.com/ch/album/violator/id665404621")).toEqual({
      type: "album",
      id: "665404621",
    });
    expect(parseAppleMusicLink("Violator by Depeche Mode\nhttps://music.apple.com/ch/album/665404621")).toEqual({
      type: "album",
      id: "665404621",
    });
  });

  it("rejects things that are not album or song links", () => {
    for (const bad of [
      "",
      "Violator",
      "https://open.spotify.com/album/1v6",
      "https://music.apple.com/ch/playlist/top-100/pl.d25f5d1181894928af76c85c967f8f31",
      "https://music.apple.com/ch/artist/depeche-mode/148662",
      "https://music.apple.com/ch/album/violator",
      "https://music.apple.com.evil.example/ch/album/x/1",
    ]) {
      expect(() => parseAppleMusicLink(bad)).toThrow(LinkError);
    }
  });
});

describe("parseLookup", () => {
  it("builds the album from the collection and its tracks", () => {
    const album = parseLookup(violator.results, "ch");
    expect(album).toMatchObject({
      appleId: "665404621",
      title: "Violator",
      artist: "Depeche Mode",
      artistId: "148662",
      releaseDate: "1990-03-19",
      year: 1990,
      genre: "Alternative",
      trackCount: 9,
      appleUrl: "https://music.apple.com/ch/album/violator/665404621",
      artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/example/source/{w}x{h}bb.jpg",
    });
    expect(album.tracks).toHaveLength(9);
    expect(album.tracks[5]).toEqual({ disc: 1, number: 6, title: "Enjoy the Silence", durationMs: 245000 });
    expect(album.durationMs).toBe(9 * 240000 + 36000);
  });

  it("sorts tracks by disc and number", () => {
    expect(parseLookup(kick.results, "ch").tracks.map((t) => t.title)).toEqual(["Guns in the Sky", "Need You Tonight"]);
  });

  it("fails when there is no album in the answer", () => {
    expect(() => parseLookup([], "ch")).toThrow(/not available in the CH Apple Music store/);
  });
});
