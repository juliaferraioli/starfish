const {
    alternateIdColumnNumber,
    githubIdColumnNumber,
    githubImportantEvents,
    githubToken,
    ignoreSelfOwnedEvents,
    minimumNumberOfContributions,
    osiLicensesOnly,
} = require('./globals');
const { createLuxonDateTimeFromIso } = require('./dateTimes');
const fetch = require('node-fetch');
const parse = require('parse-link-header');

function isEventImportant(event) {
    const type = event.type;

    if (githubImportantEvents.indexOf(type) >= 0) {
        return true;
    }
    if (event.payload) {
        const typeWithAction = `${type}.${event.payload.action}`;
        if (githubImportantEvents.indexOf(typeWithAction) >= 0) {
            return true;
        }
    }

    return false;
}

function filterResponseForImportantEvents(allEventsFromFetch) {
    return allEventsFromFetch.filter((event) => {
        return isEventImportant(event);
    });
}

function repoIsNotSelfOwned(eventType) {
    const isAuthorAlsoTheOwner = eventType.author_association === 'OWNER';

    return !isAuthorAlsoTheOwner;
}

function filterOutSelfOwnedEvents(events) {
    const filteredEvents = events.filter((event) => {
        switch (event.type) {
            case 'PullRequestEvent':
            case 'PullRequestReviewEvent':
                return repoIsNotSelfOwned(event.payload.pull_request);
            case 'CommitCommentEvent':
            case 'IssueCommentEvent':
            case 'PullRequestReviewCommentEvent':
                return repoIsNotSelfOwned(event.payload.comment);
            case 'IssuesEvent':
                return repoIsNotSelfOwned(event.payload.issue);
            default:
                return false;
        }
    });

    return filteredEvents;
}

function fetchActivities(url) {
    return new Promise((resolve) => {
        fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Basic ${githubToken}`,
            },
        })
            .then((response) => {
                if (!response.ok) {
                    console.error(`Error: ${response.status} ${response.statusText} \nFor: ${url}`);
                    throw new Error(response.statusText);
                }
                let activities = [];
                let parsed = parse(response.headers.get('link'));
                response
                    .json()
                    .then((json) => {
                        activities = activities.concat(json);
                        if (parsed && parsed.next && parsed.next.url) {
                            fetchActivities(parsed.next.url).then((nextResponse) => {
                                return resolve(activities.concat(nextResponse));
                            });
                        } else {
                            return resolve(activities);
                        }
                    })
                    .catch((err) => {
                        console.error('Error turning response into JSON:', err);
                    });
            })
            .catch((err) => console.error('Error fetching activity from GitHub', err));
    });
}

function isContributionInTimeRange(createdAt, startMoment, endMoment) {
    const momentOfContribution = createLuxonDateTimeFromIso(createdAt, 'Etc/UTC');

    return (
        momentOfContribution.toMillis() >= startMoment.toMillis() &&
        momentOfContribution.toMillis() < endMoment.toMillis()
    );
}

function fetchRepoLicense(url) {
    return new Promise((resolve) => {
        fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Basic ${githubToken}`,
            },
        })
            .then((response) => {
                if (!response.ok) {
                    console.error(`Error: ${response.status} ${response.statusText} \nFor: ${url}`);

                    return resolve('none');
                }
                response
                    .json()
                    .then((json) => {
                        let license = json.license;
                        if (license === null) {
                            return resolve('none');
                        }

                        return resolve(license.spdx_id);
                    })
                    .catch((err) => {
                        console.error('Error turning response into JSON:', err, url);
                    });
            })
            .catch((err) => console.error('ERROR GRABBING INFO FROM GITHUB!', err));
    });
}

function fetchAllLicenses(events) {
    let promises = [];
    for (let i = 0; i < events.length; i++) {
        promises.push(fetchRepoLicense(events[i].repo.url));
    }

    return Promise.all(promises);
}

function filterOnLicense(activities, results, licensesList) {
    return activities.filter((activity, i) => licensesList.includes(results[i]));
}

function filterOnDateRange(events, dateTimes) {
    const startMoment = dateTimes[0];
    const endMoment = dateTimes[1];
    const filteredEvents = events.filter((event) => {
        return isContributionInTimeRange(event.created_at, startMoment, endMoment);
    });

    return filteredEvents;
}

function processUser(row, dateTimes, licensesList) {
    const url = `https://api.github.com/users/${row[githubIdColumnNumber]}/events`;
    fetchActivities(url)
        .then((activities) => {
            let qualifyingActivities = [];
            qualifyingActivities = filterResponseForImportantEvents(activities);
            console.log(
                `After filtering for important events, ${qualifyingActivities.length} events qualify`
            );
            if (ignoreSelfOwnedEvents === 'true') {
                qualifyingActivities = filterOutSelfOwnedEvents(qualifyingActivities);
                console.log(
                    `After filtering out self-owned events, ${qualifyingActivities.length} events qualify`
                );
            }
            qualifyingActivities = filterOnDateRange(qualifyingActivities, dateTimes);
            console.log(
                `After filtering for date range, ${qualifyingActivities.length} events qualify`
            );

            return qualifyingActivities;
        })
        .then((qualifyingActivities) => {
            if (osiLicensesOnly !== 'true') {
                if ((qualifyingActivities.length = minimumNumberOfContributions)) {
                    process.stdout.write(
                        `${row[alternateIdColumnNumber]}, ${row[githubIdColumnNumber]}, ${qualifyingActivities.length}`
                    );
                }
            } else {
                fetchAllLicenses(qualifyingActivities).then((results) => {
                    qualifyingActivities = filterOnLicense(
                        qualifyingActivities,
                        results,
                        licensesList
                    );
                    console.log(
                        `After filtering on licenses, ${qualifyingActivities.length} events qualify`
                    );
                    if ((qualifyingActivities.length = minimumNumberOfContributions)) {
                        process.stdout.write(
                            `${row[alternateIdColumnNumber]}, ${row[githubIdColumnNumber]}, ${qualifyingActivities.length}`
                        );
                    }
                });
            }
        })
        .catch((err) => {
            console.error('error', err);
        });
}

module.exports = {
    filterResponseForImportantEvents,
    isContributionInTimeRange,
    processUser,
};
