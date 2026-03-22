import {
	QueryClient,
	defaultShouldDehydrateQuery,
	type QueryKey,
	type UseQueryOptions,
	queryOptions,
} from "@tanstack/react-query";

export function createV2QueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry: 1,
				staleTime: 5_000,
				refetchOnWindowFocus: false,
			},
			mutations: {
				retry: 0,
			},
			dehydrate: {
				shouldDehydrateQuery: (query) =>
					defaultShouldDehydrateQuery(query) || query.state.status === "pending",
			},
		},
	});
}

type V2QueryOptions<TQueryFnData, TQueryKey extends QueryKey> = Pick<
	UseQueryOptions<TQueryFnData, Error, TQueryFnData, TQueryKey>,
	"queryKey" | "queryFn" | "enabled" | "refetchInterval"
>;

export function v2StaticQueryOptions<
	TQueryFnData,
	TQueryKey extends QueryKey,
>(options: V2QueryOptions<TQueryFnData, TQueryKey>) {
	return queryOptions({
		...options,
		staleTime: 30_000,
	});
}

export function v2DynamicQueryOptions<
	TQueryFnData,
	TQueryKey extends QueryKey,
>(options: V2QueryOptions<TQueryFnData, TQueryKey>) {
	return queryOptions({
		...options,
		staleTime: 5_000,
	});
}
