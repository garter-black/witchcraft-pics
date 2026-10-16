import { useEffect, useState } from "react";
import { readRoute, onRouteChange } from "./route";

type Route = ReturnType<typeof readRoute>;

/** Single source of truth for which surface renders. Subscribes to the
    router's popstate events, so back/forward and direct loads agree with the
    URL, and every in-app navigate() call (studio or gallery) re-renders. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readRoute());
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    sync();
    return onRouteChange(sync);
  }, []);
  return route;
}

