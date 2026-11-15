import type { CreateEngine } from './engine';
import { createNativeEngine } from './nativeEngine';

export const createEngine: CreateEngine = async (request) => {
  switch (request.kind) {
    case 'hls':
      return (await import('./hlsEngine')).createHlsEngine(request);
    case 'dash':
      return (await import('./dashEngine')).createDashEngine(request);
    case 'mp4':
      return createNativeEngine(request);
  }
};
