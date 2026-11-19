/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { AssistantWeatherDay, AssistantWeatherForecast, AssistantWeatherLocation, normalizeAssistantWeatherLocation } from '../common/native.js';

const forecastEndpoint = 'https://api.data.pelmorex.com/weather/LongTermForecasts/';
const forecastPage = 'https://www.theweathernetwork.com/en/city';

interface PelmorexLocation {
	readonly Name?: string;
	readonly SubDivision?: string;
	readonly SubDivisionCode?: string;
}

function forecastSourceUrl(country: string, location: PelmorexLocation | undefined): string {
	const slug = (value: string | undefined) => typeof value === 'string'
		? value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
		: '';
	const city = slug(location?.Name);
	const subdivision = slug(location?.SubDivision);
	if ((country === 'CA' || country === 'US') && city && subdivision) {
		return forecastPage + '/' + country.toLowerCase() + '/' + subdivision + '/' + city + '/7-days';
	}
	return forecastPage;
}

function numberField(value: unknown): number | undefined {
	if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) { return undefined; }
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

export async function fetchAssistantWeatherForecast(
	day: AssistantWeatherDay,
	location: AssistantWeatherLocation,
	apiKey: string,
	fetcher: (url: string, options: RequestInit) => Promise<Response>,
): Promise<AssistantWeatherForecast> {
	if (day !== 'today' && day !== 'tomorrow') { throw new Error(localize('assistantWeather.invalidDay', "Choose today or tomorrow for the forecast.")); }
	const normalizedLocation = normalizeAssistantWeatherLocation(location);
	if (!normalizedLocation) {
		throw new Error(localize('assistantWeather.invalidLocation', "Enter a city, a two-letter country code, and a province, state, or region code if needed."));
	}
	const { city, country, subdivision } = normalizedLocation;
	if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(apiKey)) { throw new Error('Enter a valid Pelmorex API key.'); }
	const locationLabel = [city, subdivision, country].filter(Boolean).join(', ');
	const path = [country, subdivision, encodeURIComponent(city)].filter(Boolean).join('/');
	let response: Response;
	try {
		response = await fetcher(forecastEndpoint + path + '?locale=en-CA', {
			headers: { 'Accept': 'application/json', 'x-api-key': apiKey },
			credentials: 'omit',
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		});
	} catch {
		throw new Error('The Weather Network forecast request failed or timed out.');
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		if (response.status === 401 || response.status === 403) { throw new Error('Pelmorex rejected the API key or it lacks access to Long Term Forecasts. Check the key with /weather.'); }
		if (response.status === 404) { throw new Error(localize('assistantWeather.locationNotFound', "The Weather Network could not find {0}. Check the city and its province, state, or region.", locationLabel)); }
		throw new Error(`The Weather Network forecast is unavailable (HTTP ${response.status}).`);
	}
	const data: { LongTermPeriod?: (Record<string, unknown> | null)[]; Location?: PelmorexLocation } | null = await response.json().catch(() => null);
	const periods = Array.isArray(data?.LongTermPeriod) ? data.LongTermPeriod : [];
	// Pelmorex defines period 0 as today in the forecast location.
	const dayIndex = day === 'tomorrow' ? 1 : 0;
	const indexedPeriod = periods[dayIndex];
	const period = periods.find(item => numberField(item?.Period) === dayIndex)
		?? (indexedPeriod?.Period === undefined || indexedPeriod.Period === null ? indexedPeriod : undefined);
	const date = typeof period?.TimestampLocal === 'string' ? period.TimestampLocal.slice(0, 10) : '';
	if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(localize('assistantWeather.missingForecast', "The Weather Network did not return the requested forecast day for {0}.", locationLabel));
	}
	const highC = numberField(period.TemperatureCMax);
	const lowC = numberField(period.TemperatureCMin);
	const probability = numberField(period.POPPercentDay);
	const precipitationChancePercent = probability !== undefined && probability >= 0 && probability <= 100 ? probability : undefined;
	const conditions = typeof period.FxConditionDay === 'string' ? period.FxConditionDay.trim().slice(0, 160) || undefined : undefined;
	if (highC === undefined && lowC === undefined && precipitationChancePercent === undefined && !conditions) {
		throw new Error(localize('assistantWeather.emptyForecast', "The Weather Network returned an empty forecast for {0} on {1}.", locationLabel, date));
	}
	const providerLocation = data?.Location;
	const name = typeof providerLocation?.Name === 'string' ? providerLocation.Name.trim() : '';
	const region = typeof providerLocation?.SubDivisionCode === 'string' ? providerLocation.SubDivisionCode.trim() : '';
	return {
		source: 'The Weather Network',
		sourceUrl: forecastSourceUrl(country, providerLocation),
		location: [name || city, region || subdivision, country].filter(Boolean).join(', '),
		date, highC, lowC, precipitationChancePercent, conditions,
	};
}
