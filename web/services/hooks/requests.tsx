import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useOrg } from "../../components/layout/org/organizationContext";
import { HeliconeRequest } from "../../lib/api/request/request";
import { $JAWN_API, getJawnClient } from "../../lib/clients/jawn";
import { Result } from "../../packages/common/result";
import { FilterNode } from "../lib/filters/filterDefs";
import { placeAssetIdValues } from "../lib/requestTraverseHelper";
import { SortLeafRequest } from "../lib/sorts/requests/sorts";

function formatDateForClickHouse(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function processFilter(filter: any): any {
  if (typeof filter !== "object" || filter === null) {
    return filter;
  }

  const result: any = Array.isArray(filter) ? [] : {};

  for (const key in filter) {
    if (key === "gte" || key === "lte") {
      result[key] = formatDateForClickHouse(new Date(filter[key]));
    } else if (typeof filter[key] === "object") {
      result[key] = processFilter(filter[key]);
    } else {
      result[key] = filter[key];
    }
  }

  return result;
}

interface RequestBodyContent {
  request: any;
  response: any;
}

const requestBodyCache = new Map<string, RequestBodyContent>();

export const useGetRequestWithBodies = (requestId: string) => {
  const org = useOrg();

  return useQuery({
    queryKey: ["single-request", requestId, org?.currentOrg?.id],
    queryFn: async () => {
      const jawn = getJawnClient(org?.currentOrg?.id);
      const response = await jawn.GET(`/v1/request/{requestId}`, {
        params: {
          path: {
            requestId,
          },
        },
      });
      if (!response.data?.data?.signed_body_url) return response.data;
      if (response.data.data && response.data.data.signed_body_url) {
        const contentResponse = await fetch(response.data.data.signed_body_url);
        if (contentResponse.ok) {
          const text = await contentResponse.text();
          let content = JSON.parse(text);
          if (response.data?.data?.asset_urls) {
            content = placeAssetIdValues(
              response.data?.data?.asset_urls,
              content
            );
          }
          requestBodyCache.set(response.data?.data?.request_id, content);
          if (requestBodyCache.size > 1000) {
            requestBodyCache.clear();
          }
          response.data.data.response_body = content.response;
          response.data.data.request_body = content.request;
        }
      }

      return response.data as Result<HeliconeRequest, string>;
    },
    enabled: !!requestId && !!org?.currentOrg?.id,
  });
};

export const useGetRequestsWithBodies = (
  currentPage: number,
  currentPageSize: number,
  advancedFilter: FilterNode,
  sortLeaf: SortLeafRequest,
  isLive: boolean = false,
  isCached: boolean = false
) => {
  // First query to fetch the initial request data
  const requestQuery = $JAWN_API.useQuery(
    "post",
    "/v1/request/query-clickhouse",
    {
      body: {
        filter: advancedFilter as any,
        offset: (currentPage - 1) * currentPageSize,
        limit: currentPageSize,
        sort: sortLeaf as any,
        isCached: isCached as any,
      },
    },
    {
      refetchOnWindowFocus: false,
      refetchInterval: isLive ? 1_000 : false,
      keepPreviousData: true,
    }
  );

  // Second query to fetch and process request bodies
  const { data: requests, isLoading: bodiesLoading } = useQuery<
    HeliconeRequest[]
  >({
    queryKey: ["requestsWithSignedUrls", requestQuery.data?.data],
    placeholderData: (prev) => prev,
    enabled: !!requestQuery.data?.data?.length,
    queryFn: async () => {
      try {
        return await Promise.all(
          requestQuery.data?.data?.map(async (request) => {
            // Return from cache if available
            if (requestBodyCache.has(request.request_id)) {
              const bodyContent = requestBodyCache.get(request.request_id);
              return {
                ...request,
                request_body: bodyContent?.request,
                response_body: bodyContent?.response,
              };
            }

            // Skip if no signed URL is available
            if (!request.signed_body_url) return request;

            try {
              const contentResponse = await fetch(request.signed_body_url);
              if (!contentResponse.ok) {
                console.error(
                  `Error fetching request body: ${contentResponse.status}`
                );
                return request;
              }

              const text = await contentResponse.text();
              let content = JSON.parse(text);

              if (request.asset_urls) {
                content = placeAssetIdValues(request.asset_urls, content);
              }

              // Update cache with size limit protection
              requestBodyCache.set(request.request_id, content);
              if (requestBodyCache.size > 10_000) {
                requestBodyCache.clear();
              }

              return {
                ...request,
                request_body: content.request,
                response_body: content.response,
              };
            } catch (error) {
              console.error("Error processing request body:", error);
              return request;
            }
          }) ?? []
        );
      } catch (error) {
        console.error("Error processing requests with bodies:", error);
        return [];
      }
    },
  });

  const mergedRequests = useMemo(() => {
    const rawRequests = requestQuery.data?.data ?? [];
    return rawRequests.map((rawRequest) => {
      const requestWithBody = requests?.find(
        (request) => request.request_id === rawRequest.request_id
      );
      if (requestWithBody) {
        return requestWithBody;
      }
      return rawRequest;
    });
  }, [requestQuery, requests]);

  return {
    isLoading: requestQuery.isLoading || bodiesLoading,
    refetch: requestQuery.refetch,
    isRefetching: requestQuery.isRefetching,
    requests: mergedRequests,
    completedQueries: mergedRequests?.length ?? 0,
    totalQueries: mergedRequests?.length ?? 0,
  };
};

const useGetRequests = (
  currentPage: number,
  currentPageSize: number,
  advancedFilter: FilterNode,
  sortLeaf: SortLeafRequest,
  isCached: boolean = false,
  isLive: boolean = false
) => {
  return {
    requests: useGetRequestsWithBodies(
      currentPage,
      currentPageSize,
      advancedFilter,
      sortLeaf,
      isLive,
      isCached
    ),
    count: useQuery({
      queryKey: [
        "requestsCount",
        currentPage,
        currentPageSize,
        advancedFilter,
        sortLeaf,
        isCached,
      ],
      queryFn: async (query) => {
        const advancedFilter = query.queryKey[3];
        const isCached = query.queryKey[5];
        const processedFilter = processFilter(advancedFilter);
        return await fetch("/api/request/count", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filter: processedFilter,
            isCached,
          }),
        }).then((res) => res.json() as Promise<Result<number, string>>);
      },
      refetchOnWindowFocus: false,
      refetchInterval: isLive ? 2_000 : false,
      gcTime: 5 * 60 * 1000,
    }),
  };
};

const useGetRequestCountClickhouse = (
  startDateISO: string,
  endDateISO: string
) => {
  const { data, isLoading, refetch } = $JAWN_API.useQuery(
    "post",
    "/v1/request/count/query",
    {
      body: {
        filter: {
          left: {
            request_response_rmt: {
              request_created_at: {
                gte: startDateISO,
              },
            },
          },
          operator: "and",
          right: {
            request_response_rmt: {
              request_created_at: {
                lte: endDateISO,
              },
            },
          },
        },
      },
    },
    { refetchOnWindowFocus: false }
  );

  return {
    count: data,
    isLoading,
    refetch,
  };
};

export { useGetRequestCountClickhouse, useGetRequests };
