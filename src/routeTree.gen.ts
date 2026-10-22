/* eslint-disable */

// @ts-nocheck

// noinspection JSUnusedGlobalSymbols

// Этот файл был автоматически сгенерирован TanStack Router.
// НЕ вносите в этот файл никаких изменений: он будет перезаписан.
// Кроме того, исключите этот файл из линтера и/или форматтера, чтобы его не проверяли и не изменяли.

import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as ApiCronRouteImport } from './routes/api/cron'
import { Route as ApiTelegramRouteImport } from './routes/api/telegram'

const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)
const ApiCronRoute = ApiCronRouteImport.update({
  id: '/api/cron',
  path: '/api/cron',
  getParentRoute: () => rootRouteImport,
} as any)
const ApiTelegramRoute = ApiTelegramRouteImport.update({
  id: '/api/telegram',
  path: '/api/telegram',
  getParentRoute: () => rootRouteImport,
} as any)

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/api/cron': typeof ApiCronRoute
  '/api/telegram': typeof ApiTelegramRoute
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
  '/api/cron': typeof ApiCronRoute
  '/api/telegram': typeof ApiTelegramRoute
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/': typeof IndexRoute
  '/api/cron': typeof ApiCronRoute
  '/api/telegram': typeof ApiTelegramRoute
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths: '/' | '/api/cron' | '/api/telegram'
  fileRoutesByTo: FileRoutesByTo
  to: '/' | '/api/cron' | '/api/telegram'
  id: '__root__' | '/' | '/api/cron' | '/api/telegram'
  fileRoutesById: FileRoutesById
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute
  ApiCronRoute: typeof ApiCronRoute
  ApiTelegramRoute: typeof ApiTelegramRoute
}

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/api/cron': {
      id: '/api/cron'
      path: '/api/cron'
      fullPath: '/api/cron'
      preLoaderRoute: typeof ApiCronRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/api/telegram': {
      id: '/api/telegram'
      path: '/api/telegram'
      fullPath: '/api/telegram'
      preLoaderRoute: typeof ApiTelegramRouteImport
      parentRoute: typeof rootRouteImport
    }
  }
}

const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
  ApiCronRoute: ApiCronRoute,
  ApiTelegramRoute: ApiTelegramRoute,
}
export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>()

import type { getRouter } from './router.tsx'
import type { createStart } from '@tanstack/react-start'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
  }
}
