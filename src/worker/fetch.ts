import { BareResponseFetch } from "@mercuryworkshop/bare-mux";
import { MessageW2C, ScramjetServiceWorker } from ".";
import { renderError } from "./error";
import { FakeServiceWorker } from "./fakesw";
import { CookieStore } from "../shared/cookie";
import {
	ScramjetHeaders,
	unrewriteUrl,
	rewriteUrl,
	rewriteCss,
	rewriteHeaders,
	rewriteHtml,
	rewriteJs,
	rewriteWorkers,
	unrewriteBlob,
} from "../shared";

import type { URLMeta } from "../shared/rewriters/url";

function newmeta(url: URL): URLMeta {
	return {
		origin: url,
		base: url,
	};
}

export async function swfetch(
	this: ScramjetServiceWorker,
	request: Request,
	client: Client | null
) {
	const urlParam = new URLSearchParams(new URL(request.url).search);

	if (urlParam.has("url")) {
		return Response.redirect(
			rewriteUrl(urlParam.get("url"), newmeta(new URL(urlParam.get("url"))))
		);
	}

	try {
		const requesturl = new URL(request.url);
		let workertype = "";
		if (requesturl.searchParams.has("type")) {
			workertype = requesturl.searchParams.get("type") as string;
			requesturl.searchParams.delete("type");
		}
		if (requesturl.searchParams.has("dest")) {
			requesturl.searchParams.delete("dest");
		}

		if (
			requesturl.pathname.startsWith(this.config.prefix + "blob:") ||
			requesturl.pathname.startsWith(this.config.prefix + "data:")
		) {
			let dataurl = requesturl.pathname.substring(this.config.prefix.length);
			if (dataurl.startsWith("blob:")) {
				dataurl = unrewriteBlob(dataurl);
			}

			const response: Response = await fetch(dataurl, {});

			let body: BodyType;

			if (response.body) {
				body = await rewriteBody(
					response,
					{
						base: new URL(new URL(client.url).origin),
						origin: new URL(new URL(client.url).origin),
					},
					request.destination,
					workertype,
					this.cookieStore
				);
			}
			const headers = Object.fromEntries(response.headers.entries());

			if (crossOriginIsolated) {
				headers["Cross-Origin-Opener-Policy"] = "same-origin";
				headers["Cross-Origin-Embedder-Policy"] = "require-corp";
			}

			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: headers,
			});
		}

		const url = new URL(unrewriteUrl(requesturl));

		const activeWorker: FakeServiceWorker | null = this.serviceWorkers.find(
			(w) => w.origin === url.origin
		);

		if (
			activeWorker &&
			activeWorker.connected &&
			urlParam.get("from") !== "swruntime"
		) {
			// TODO: check scope
			const r = await activeWorker.fetch(request);
			if (r) return r;
		}
		if (url.origin == new URL(request.url).origin) {
			throw new Error(
				"attempted to fetch from same origin - this means the site has obtained a reference to the real origin, aborting"
			);
		}

		const headers = new ScramjetHeaders();
		for (const [key, value] of request.headers.entries()) {
			headers.set(key, value);
		}

		if (
			client &&
			new URL(client.url).pathname.startsWith(self.$scramjet.config.prefix)
		) {
			// TODO: i was against cors emulation but we might actually break stuff if we send full origin/referrer always
			const clientURL = new URL(unrewriteUrl(client.url));
			if (clientURL.toString().includes("youtube.com")) {
				// console.log(headers);
			} else {
				headers.set("Referer", clientURL.toString());
				headers.set("Origin", clientURL.origin);
			}
		}

		const cookies = this.cookieStore.getCookies(url, false);

		if (cookies.length) {
			headers.set("Cookie", cookies);
		}

		// TODO this is wrong somehow
		headers.set("Sec-Fetch-Mode", "cors");
		headers.set("Sec-Fetch-Site", "same-origin");
		headers.set("Sec-Fetch-Dest", "empty");

		const response: BareResponseFetch = await this.client.fetch(url, {
			method: request.method,
			body: request.body,
			headers: headers.headers,
			credentials: "omit",
			mode: request.mode === "cors" ? request.mode : "same-origin",
			cache: request.cache,
			redirect: "manual",
			//@ts-ignore why the fuck is this not typed mircosoft
			duplex: "half",
		});

		return await handleResponse(
			url,
			workertype,
			request.destination,
			response,
			this.cookieStore,
			client,
			this
		);
	} catch (err) {
		console.error("ERROR FROM SERVICE WORKER FETCH", err);
		if (!["document", "iframe"].includes(request.destination))
			return new Response(undefined, { status: 500 });

		return renderError(err, unrewriteUrl(request.url));
	}
}

async function handleResponse(
	url: URL,
	workertype: string,
	destination: RequestDestination,
	response: BareResponseFetch,
	cookieStore: CookieStore,
	client: Client,
	swtarget: ScramjetServiceWorker
): Promise<Response> {
	let responseBody: BodyType;
	const responseHeaders = rewriteHeaders(response.rawHeaders, newmeta(url));

	const maybeHeaders = responseHeaders["set-cookie"] || [];
	for (const cookie in maybeHeaders) {
		if (client)
			client.postMessage({
				scramjet$type: "cookie",
				cookie,
				url: url.href,
			} as MessageW2C);
	}

	await cookieStore.setCookies(
		maybeHeaders instanceof Array ? maybeHeaders : [maybeHeaders],
		url
	);

	for (const header in responseHeaders) {
		// flatten everything past here
		if (Array.isArray(responseHeaders[header]))
			responseHeaders[header] = responseHeaders[header][0];
	}

	if (response.body) {
		responseBody = await rewriteBody(
			response,
			newmeta(url),
			destination,
			workertype,
			cookieStore
		);
	}

	// downloads
	if (["document", "iframe"].includes(destination)) {
		const header = responseHeaders["content-disposition"];

		// validate header and test for filename
		if (!/\s*?((inline|attachment);\s*?)filename=/i.test(header)) {
			// if filename= wasn"t specified then maybe the remote specified to download this as an attachment?
			// if it"s invalid then we can still possibly test for the attachment/inline type
			const type = /^\s*?attachment/i.test(header) ? "attachment" : "inline";

			// set the filename
			const [filename] = new URL(response.finalURL).pathname
				.split("/")
				.slice(-1);

			responseHeaders["content-disposition"] =
				`${type}; filename=${JSON.stringify(filename)}`;
		}
	}
	if (responseHeaders["accept"] === "text/event-stream") {
		responseHeaders["content-type"] = "text/event-stream";
	}

	// scramjet runtime can use features that permissions-policy blocks
	delete responseHeaders["permissions-policy"];

	if (
		crossOriginIsolated &&
		[
			"document",
			"iframe",
			"worker",
			"sharedworker",
			"style",
			"script",
		].includes(destination)
	) {
		responseHeaders["Cross-Origin-Embedder-Policy"] = "require-corp";
		responseHeaders["Cross-Origin-Opener-Policy"] = "same-origin";
	}

	const ev = new ScramjetHandleResponseEvent("handleResponse");
	ev.responseBody = responseBody;
	ev.responseHeaders = responseHeaders;
	ev.status = response.status;
	ev.statusText = response.statusText;
	ev.destination = destination;
	ev.url = url;
	ev.rawResponse = response;
	ev.client = client;
	swtarget.dispatchEvent(ev);

	return new Response(ev.responseBody, {
		headers: ev.responseHeaders as HeadersInit,
		status: ev.status,
		statusText: ev.statusText,
	});
}

async function rewriteBody(
	response: Response,
	meta: URLMeta,
	destination: RequestDestination,
	workertype: string,
	cookieStore: CookieStore
): Promise<BodyType> {
	switch (destination) {
		case "iframe":
		case "document":
			if (response.headers.get("content-type")?.startsWith("text/html")) {
				return rewriteHtml(await response.text(), cookieStore, meta, true);
			} else {
				return response.body;
			}
		case "script":
			return rewriteJs(await response.arrayBuffer(), meta);
			// Disable threading for now, it's causing issues.
			// responseBody = await this.threadpool.rewriteJs(await responseBody.arrayBuffer(), url.toString());
		case "style":
			return rewriteCss(await response.text(), meta);
		case "sharedworker":
		case "worker":
			return rewriteWorkers(await response.arrayBuffer(), workertype, meta);
		default:
			return response.body;
	}
}

type BodyType = string | ArrayBuffer | Blob | ReadableStream<any>;

export class ScramjetHandleResponseEvent extends Event {
	public responseHeaders: Record<string, string>;
	public responseBody: BodyType;
	public status: number;
	public statusText: string;
	public destination: string;
	public url: URL;
	public rawResponse: BareResponseFetch;
	public client: Client;
}
