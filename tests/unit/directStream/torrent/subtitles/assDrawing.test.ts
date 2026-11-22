import { describe, expect, it } from 'vitest';
import { cleanAssVtt, isAssDrawing, stripAssComments } from '../../../../../src/directStream/torrent/subtitles/assDrawing.js';
import { cleanCue, parseFeedFile } from '../../../../../src/directStream/torrent/subtitles/feed.js';

// The cues ffmpeg made of JUJUTSU KAISEN S01E04's "Road Closed" sign (the [Kaizoku] ASS track), 15.62 s in.
const BOARD = 'm 385.98 0 l 4.55 64.75 0 69.17 3.34 192 5.8 196.73 385.98 144.86 385.98 0';
const ROUND = 'm 54.73 0 b 30.44 0 7.65 19.4 3.82 43.33 0 67.26 16.58 86.66 40.87 86.66 m 84.46 43.33 b 83.92 46.74 82.9 50.03 81.5 53.16 l 53.27 41.85 80.93 22.25';

describe('an ASS drawing', () => {
  it('is a text of drawing commands and coordinates only', () => {
    expect(isAssDrawing(BOARD)).toBe(true);
    expect(isAssDrawing(ROUND)).toBe(true);
    expect(isAssDrawing('m 0 0 l 100 0 100 -20.5 0 -20.5')).toBe(true);
    expect(isAssDrawing(`<b>${BOARD}</b>`)).toBe(true);
    expect(isAssDrawing('{=6}m -208.25 -22.5 l 212.875 -22.5 212.875 40.5 -208.25 40.5')).toBe(true);
    expect(isAssDrawing(BOARD.replace(' l ', '\nl '))).toBe(true);
    expect(isAssDrawing('<b>625.52 110.8 b 622.4 111.8 620.18 112.4 618.05 113.2 l 625.5 110.8</b>')).toBe(true);
  });

  it('is never a line somebody says or a sign somebody reads', () => {
    for (const said of ['Road Closed', 'm', 'M 16', 'Room 385.98', '10 20 30', '10 20 30 40 50', 'b 2', 'm 1 2', 'm 1 2 metres', 'I am 20', `${BOARD} Road Closed`]) {
      expect(isAssDrawing(said), said).toBe(false);
    }
  });

  it('is no cue of a feed, neither appended nor read back from a feed kept on disk', () => {
    expect(cleanCue({ start_s: 15.62, end_s: 15.66, text: BOARD })).toBeNull();
    expect(cleanCue({ start_s: 15.62, end_s: 15.66, text: 'Road Closed' })).not.toBeNull();
    const kept = [BOARD, ROUND, 'Road Closed'].map((text) => JSON.stringify({ start_s: 15.62, end_s: 15.66, text })).join('\n');
    expect(parseFeedFile(`${kept}\n{"complete":true}\n`)).toEqual({ cues: [{ start_s: 15.62, end_s: 15.66, text: 'Road Closed' }], complete: true });
  });

  it('is taken out of a converted WebVTT, which keeps its header and its other cues', () => {
    const vtt = `WEBVTT\n\n00:15.620 --> 00:15.660\n${BOARD}\n\n00:15.620 --> 00:15.660\nRoad Closed\n\n00:16.000 --> 00:17.000\n${ROUND}\n\n00:18.000 --> 00:19.000\nLet's go.\n`;
    expect(cleanAssVtt(vtt)).toBe("WEBVTT\n\n00:15.620 --> 00:15.660\nRoad Closed\n\n00:18.000 --> 00:19.000\nLet's go.");
  });

  it('has its brace blocks taken out: nothing between braces is ever shown', () => {
    expect(stripAssComments('<b>{*}Mr. Ijichi{*Ijichi-san}, question.</b>')).toBe('<b>Mr. Ijichi, question.</b>');
    expect(stripAssComments("It's a feast. {this could be a jojo's reference}")).toBe("It's a feast.");
    expect(stripAssComments('First {note} line\n{=6}Second line')).toBe('First line\nSecond line');
    expect(stripAssComments('No braces here.')).toBe('No braces here.');
    expect(cleanCue({ start_s: 21.33, end_s: 22.71, text: '<b>{*}Mr. Ijichi{*Ijichi-san}, question.</b>' })).toEqual({ start_s: 21.33, end_s: 22.71, text: '<b>Mr. Ijichi, question.</b>' });
    expect(cleanCue({ start_s: 1, end_s: 2, text: '<b>{not very readable}</b>' })).toBeNull();
    expect(cleanAssVtt('WEBVTT\n\n00:01.000 --> 00:02.000\n{*}Mr. Ijichi{*Ijichi-san}, question.\n\n00:03.000 --> 00:04.000\n{Oof}\n')).toBe('WEBVTT\n\n00:01.000 --> 00:02.000\nMr. Ijichi, question.');
  });
});
