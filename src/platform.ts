try {
  const stations = await this.axiosInstance.get(
    `https://api.weather.gov/points/${latitude},${longitude}/stations`
  );

  const stationList = stations.data.features
    .filter((f: any) => /^[A-Z0-9]{3,4}$/.test(f.properties.stationIdentifier))
    .map((f: any) => ({
      id: f.properties.stationIdentifier,
      distance: f.properties.distance?.value ?? Number.MAX_SAFE_INTEGER
    }));

  if (stationList.length === 0) {
    this.log.error('No valid NOAA stations found.');
    return;
  }

  // ✅ Sort by distance ascending
  stationList.sort((a: any, b: any) => a.distance - b.distance);

  // Log all sorted stations
  this.log.warn('NOAA stations sorted by distance:', 
    stationList.map((s: any) => `${s.id} (${s.distance}m)`).join(', '));

  // Pick the nearest station
  stationId = stationList[0].id;
  this.log.info('Using closest NOAA station:', stationId);

} catch (error) {
  this.log.error('Failed to fetch NOAA stations', error);
  return;
}
