export interface RouteInfo {
  path: string;
  isStatic: boolean;
  srcRoute?: string;
  regex?: string;
}

/** Build Output API v3 route entry. */
export interface OutputRoute {
  src?: string;
  headers?: Record<string, string>;
  status?: number;
  methods?: string[];
  continue?: boolean;
  handle?: "filesystem" | "miss" | "hit" | "rewrite" | "error";
}

/** colon = :param, dollar = $param, bracket = [param], at = @param */
export type RouteSyntax = "colon" | "dollar" | "bracket" | "at" | "auto";

export interface RouteToRegexOptions {
  syntax?: RouteSyntax;
  trailingSlashOptional?: boolean;
  anchored?: boolean;
}

export function isDynamicRoute(routePath: string): boolean {
  if (/:[\w]+\??/.test(routePath)) return true;
  if (/\$[\w]*/.test(routePath)) return true;
  if (/\[{1,2}(\.{3})?[\w]+\]{1,2}/.test(routePath)) return true;
  if (/@[\w]+/.test(routePath)) return true;
  if (/\*/.test(routePath)) return true;
  return false;
}

export function isCatchAllRoute(routePath: string): boolean {
  if (/\*/.test(routePath)) return true;
  if (/\/\$$/.test(routePath) || routePath === "$") return true;
  if (/\[{1,2}\.{3}[\w]+\]{1,2}/.test(routePath)) return true;
  return false;
}

function detectRouteSyntax(routePath: string): RouteSyntax {
  if (/@[\w]+/.test(routePath)) return "at";
  if (/\$[\w]+/.test(routePath) || /\/\$$/.test(routePath)) return "dollar";
  if (/\[{1,2}(\.{3})?[\w]+\]{1,2}/.test(routePath)) return "bracket";
  return "colon";
}

/** Convert a route path to an RE2 regex pattern. */
export function routeToRegex(routePath: string, options: RouteToRegexOptions = {}): string {
  const { syntax = "auto", trailingSlashOptional = true, anchored = true } = options;

  const effectiveSyntax = syntax === "auto" ? detectRouteSyntax(routePath) : syntax;
  let pattern = routePath.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  switch (effectiveSyntax) {
    case "at":
      pattern = convertAtSyntax(pattern);
      break;
    case "dollar":
      pattern = convertDollarSyntax(pattern);
      break;
    case "bracket":
      pattern = convertBracketSyntax(pattern);
      break;
    case "colon":
    default:
      pattern = convertColonSyntax(pattern);
      break;
  }

  if (trailingSlashOptional && !pattern.endsWith(")?$") && !pattern.endsWith(")?")) {
    pattern = pattern + "/?";
  }

  if (anchored) {
    if (!pattern.startsWith("^")) pattern = "^" + pattern;
    if (!pattern.endsWith("$")) pattern = pattern + "$";
  }

  return pattern;
}

function convertColonSyntax(pattern: string): string {
  if (/\/\*$/.test(pattern) || pattern === "*") {
    pattern = pattern.replace(/\/?\*$/, "(?:/(.*))?");
  } else if (/\*/.test(pattern)) {
    pattern = pattern.replace(/\*/g, "(.*)");
  }
  pattern = pattern.replace(/\/:(\w+)\?/g, "(?:/([^/]+))?");
  pattern = pattern.replace(/:(\w+)/g, "([^/]+)");
  return pattern;
}

function convertDollarSyntax(pattern: string): string {
  if (/\\\$(?!\w)/.test(pattern) || pattern === "\\$") {
    pattern = pattern.replace(/\/?\\\$(?!\w)/, "(?:/(.*))?");
  }
  pattern = pattern.replace(/\\\$(\w+)/g, "([^/]+)");
  return pattern;
}

function convertBracketSyntax(pattern: string): string {
  pattern = pattern.replace(/\/\\\[\\\[\\\.\\\.\\\.(\w+)\\\]\\\]/g, "(?:/(.*))?");
  pattern = pattern.replace(/\/\\\[\\\.\\\.\\\.(\w+)\\\]/g, "(?:/(.*))?");
  pattern = pattern.replace(/\/\\\[\\\[(\w+)\\\]\\\]/g, "(?:/([^/]+))?");
  pattern = pattern.replace(/\\\[(\w+)\\\]/g, "([^/]+)");
  return pattern;
}

function convertAtSyntax(pattern: string): string {
  pattern = pattern.replace(/@(\w+)/g, "([^/]+)");
  return pattern;
}

function getRoutePriority(routePath: string): number {
  let score = 0;
  if (isCatchAllRoute(routePath)) {
    score += 1000;
  } else if (isDynamicRoute(routePath)) {
    score += 100;
  }
  const segments = routePath.split("/").filter(Boolean);
  score -= segments.length * 10;
  const staticSegments = segments.filter((seg) => {
    return (
      !/:[\w]+/.test(seg) &&
      !/\$[\w]*/.test(seg) &&
      !/\[/.test(seg) &&
      !/@[\w]+/.test(seg) &&
      seg !== "*"
    );
  });
  score -= staticSegments.length * 5;
  return score;
}

export function sortRoutesByPriority(routes: RouteInfo[]): RouteInfo[] {
  return [...routes].sort((a, b) => {
    const aPath = a.srcRoute || a.path;
    const bPath = b.srcRoute || b.path;
    return getRoutePriority(aPath) - getRoutePriority(bPath);
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function convertRoutesToOutputRoutes(
  routes: RouteInfo[],
  options: RouteToRegexOptions = {}
): OutputRoute[] {
  const sorted = sortRoutesByPriority(routes);
  return sorted.map((route) => {
    const routePath = route.srcRoute || route.path;
    const src = isDynamicRoute(routePath)
      ? routeToRegex(routePath, options)
      : `^${escapeRegex(routePath)}$`;
    return { src };
  });
}
