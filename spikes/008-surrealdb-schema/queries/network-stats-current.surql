-- Current aggregate stats.
SELECT * FROM network_stats
WHERE scope = $scope
LIMIT 1;
