import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const baseUrl = 'https://player.videasy.net';

async function scrapeMovie(ctx: MovieScrapeContext): Promise<SourcererOutput> {
  const movieId = ctx.media.tmdbId;
  
  ctx.progress(30);

  const embedUrl = `${baseUrl}/movie/${movieId}`;
  
  ctx.progress(90);

  return {
    embeds: [
      {
        embedId: 'videasy',
        url: embedUrl,
      },
    ],
  };
}

async function scrapeShow(ctx: ShowScrapeContext): Promise<SourcererOutput> {
  const showId = ctx.media.tmdbId;
  const season = ctx.media.season.number;
  const episode = ctx.media.episode.number;
  
  ctx.progress(30);

  const embedUrl = `${baseUrl}/tv/${showId}/${season}/${episode}`;
  
  ctx.progress(90);

  return {
    embeds: [
      {
        embedId: 'videasy',
        url: embedUrl,
      },
    ],
  };
}

export const videasyScraper = makeSourcerer({
  id: 'videasy',
  name: 'VIDEASY',
  rank: 150,
  disabled: false,
  flags: [],
  scrapeMovie,
  scrapeShow,
}); 