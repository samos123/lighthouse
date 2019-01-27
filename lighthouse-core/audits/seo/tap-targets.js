/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Checks that links, buttons, etc. are sufficiently large and that there's
 * no other tap target that's too close so that the user might accidentally tap on.
 */
const Audit = require('../audit');
const ViewportAudit = require('../viewport');
const {
  getRectOverlapArea,
  getRectAtCenter,
  allRectsContainedWithinEachOther,
  getLargestRect,
} = require('../../lib/rect-helpers');
const {getTappableRectsFromClientRects} = require('../../lib/tappable-rects');
const i18n = require('../../lib/i18n/i18n.js');

const UIStrings = {
  /** Title of a Lighthouse audit that provides detail on whether tap targets on a page (like buttons and links) are big enough so they can easily be tapped on a mobile device. This descriptive title is shown when tap targets are easy to tap. */
  title: 'Tap targets are sized appropriately`',
  /** Title of a Lighthouse audit that provides detail on a page's rel=canonical link. This descriptive title is shown to users when the rel=canonical link is invalid and should be fixed. This imperative title is shown when tap targets are not easy to tap. */
  failureTitle: 'Tap targets are not sized appropriately',
  /** Description of a Lighthouse audit that tells the user why links and buttons need to be big enough and what 'big enough' that means. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description: 'Interactive elements like buttons and links should be large enough (48x48px), and have enough space around them, to be easy enough to tap without overlapping onto other elements. [Learn more](https://developers.google.com/web/fundamentals/accessibility/accessible-styles#multi-device_responsive_design).',
  /** Label of a table column that identifies tap targets (like links and buttons) that have failed the audit and aren't easy to tap on. */
  tapTargetHeader: 'Tap Target',
  /** Label of a table column that specifies the size of tap targets like links and buttons. */
  sizeHeader: 'Size',
  /** Label of a table column that identifies a tap target (like a link or button) that overlaps with another tap target. */
  overlappingTargetHeader: 'Overlapping Target',
  /** Explanatory message stating that there was a failure in an audit caused by the viewport meta tag not being optimized for mobile screens, which caused tap targets like links and buttons to be too small to tap on. */
  // eslint-disable-next-line
  explanationViewportMetaNotOptimized: 'Tap targets are too small because there\'s no viewport meta tag optimized for mobile screens',
  /** Explanatory message stating that a certain percentage of the tap targets on the page (like links and buttons) are of an appropriately large size. */
  displayValue: '{decimalProportion, number, percent} appropriately sized tap targets',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

const FINGER_SIZE_PX = 48;
// Ratio of the finger area tapping on an unintended element
// to the finger area tapping on the intended element
const MAX_ACCEPTABLE_OVERLAP_SCORE_RATIO = 0.25;


/**
 * @param {LH.Artifacts.Rect} cr
 */
function clientRectBelowMinimumSize(cr) {
  return cr.width < FINGER_SIZE_PX || cr.height < FINGER_SIZE_PX;
}

/**
 * A target is "too small" if none of its clientRects are at least the size of a finger.
 * @param {LH.Artifacts.TapTarget[]} targets
 * @returns {LH.Artifacts.TapTarget[]}
 */
function getTooSmallTargets(targets) {
  return targets.filter(target => {
    return target.clientRects.every(clientRectBelowMinimumSize);
  });
}

/**
 * @param {LH.Artifacts.TapTarget[]} tooSmallTargets
 * @param {LH.Artifacts.TapTarget[]} allTargets
 * @returns {TapTargetOverlapFailure[]}
 */
function getAllOverlapFailures(tooSmallTargets, allTargets) {
  /** @type {TapTargetOverlapFailure[]} */
  let failures = [];

  tooSmallTargets.forEach(target => {
    const overlappingTargets = getAllOverlapFailuresForTarget(
      target,
      allTargets
    );

    failures = failures.concat(overlappingTargets);
  });

  return failures;
}

/**
 *
 * @param {LH.Artifacts.TapTarget} tapTarget
 * @param {LH.Artifacts.TapTarget[]} allTapTargets
 * @returns {TapTargetOverlapFailure[]}
 */
function getAllOverlapFailuresForTarget(tapTarget, allTapTargets) {
  /** @type TapTargetOverlapFailure[] */
  const failures = [];

  for (const maybeOverlappingTarget of allTapTargets) {
    if (maybeOverlappingTarget === tapTarget) {
      // checking the same target with itself, skip
      continue;
    }

    const failure = getOverlapFailureForTargetPair(tapTarget, maybeOverlappingTarget);
    if (failure) {
      failures.push(failure);
    }
  }

  return failures;
}

/**
 * @param {LH.Artifacts.TapTarget} tapTarget
 * @param {LH.Artifacts.TapTarget} maybeOverlappingTarget
 * @returns {TapTargetOverlapFailure | null}
 */
function getOverlapFailureForTargetPair(tapTarget, maybeOverlappingTarget) {
  const isHttpOrHttpsLink = /https?:\/\//.test(tapTarget.href);
  if (isHttpOrHttpsLink && tapTarget.href === maybeOverlappingTarget.href) {
    // no overlap because same target action
    return null;
  }

  // Convert client rects to unique tappable areas from a user's perspective
  const tappableRects = getTappableRectsFromClientRects(tapTarget.clientRects);
  if (allRectsContainedWithinEachOther(tappableRects, maybeOverlappingTarget.clientRects)) {
    // If one tap target is fully contained within the other that's
    // probably intentional (e.g. an item with a delete button inside).
    // We'll miss some problems because of this, but that's better
    // than falsely reporting a failure.
    return null;
  }

  /** @type TapTargetOverlapFailure | null */
  let greatestFailure = null;
  for (const targetCR of tappableRects) {
    for (const maybeOverlappingCR of maybeOverlappingTarget.clientRects) {
      const failure = getOverlapFailureForClientRectPair(targetCR, maybeOverlappingCR);
      if (failure) {
        // only update our state if this was the biggest failure we've seen for this pair
        if (!greatestFailure ||
          failure.overlapScoreRatio > greatestFailure.overlapScoreRatio) {
          greatestFailure = {
            ...failure,
            tapTarget,
            overlappingTarget: maybeOverlappingTarget,
          };
        }
      }
    }
  }
  return greatestFailure;
}

/**
 * @param {LH.Artifacts.Rect} targetCR
 * @param {LH.Artifacts.Rect} maybeOverlappingCR
 * @returns {ClientRectOverlapFailure | null}
 */
function getOverlapFailureForClientRectPair(targetCR, maybeOverlappingCR) {
  const fingerRect = getRectAtCenter(targetCR, FINGER_SIZE_PX);
  // Score indicates how much of the finger area overlaps each target when the user
  // taps on the center of targetCR
  const tapTargetScore = getRectOverlapArea(fingerRect, targetCR);
  const maybeOverlappingScore = getRectOverlapArea(fingerRect, maybeOverlappingCR);

  const overlapScoreRatio = maybeOverlappingScore / tapTargetScore;
  if (overlapScoreRatio < MAX_ACCEPTABLE_OVERLAP_SCORE_RATIO) {
    // low score means it's clear that the user tried to tap on the targetCR,
    // rather than the other tap target client rect
    return null;
  }

  return {
    overlapScoreRatio,
    tapTargetScore,
    overlappingTargetScore: maybeOverlappingScore,
  };
}

/**
 * Only report one failure if two targets overlap each other
 * @param {TapTargetOverlapFailure[]} overlapFailures
 * @returns {TapTargetOverlapFailure[]}
 */
function mergeSymmetricFailures(overlapFailures) {
  /** @type TapTargetOverlapFailure[] */
  const failuresAfterMerging = [];

  overlapFailures.forEach((failure, overlapFailureIndex) => {
    const symmetricFailure = overlapFailures.find(f =>
      f.tapTarget === failure.overlappingTarget &&
      f.overlappingTarget === failure.tapTarget
    );

    if (!symmetricFailure) {
      failuresAfterMerging.push(failure);
      return;
    }

    const {overlapScoreRatio: failureOSR} = failure;
    const {overlapScoreRatio: symmetricOSR} = symmetricFailure;
    // Push if:
    // - the current failure has a higher OSR
    // - OSRs are the same, and the current failure comes before its symmetric partner in the list
    // Otherwise do nothing and let the symmetric partner be pushed later.
    if (failureOSR > symmetricOSR || (
      failureOSR === symmetricOSR &&
      overlapFailureIndex < overlapFailures.indexOf(symmetricFailure)
    )) {
      failuresAfterMerging.push(failure);
    }
  });

  return failuresAfterMerging;
}

/**
 * @param {TapTargetOverlapFailure[]} overlapFailures
 * @returns {TapTargetTableItem[]}
 */
function getTableItems(overlapFailures) {
  const tableItems = overlapFailures.map(failure => {
    const largestCR = getLargestRect(failure.tapTarget.clientRects);
    const width = Math.floor(largestCR.width);
    const height = Math.floor(largestCR.height);
    const size = width + 'x' + height;
    return {
      tapTarget: targetToTableNode(failure.tapTarget),
      overlappingTarget: targetToTableNode(failure.overlappingTarget),
      tapTargetScore: failure.tapTargetScore,
      overlappingTargetScore: failure.overlappingTargetScore,
      overlapScoreRatio: failure.overlapScoreRatio,
      size,
      width,
      height,
    };
  });

  tableItems.sort((a, b) => {
    return b.overlapScoreRatio - a.overlapScoreRatio;
  });

  return tableItems;
}

/**
 * @param {LH.Artifacts.TapTarget} target
 * @returns {LH.Audit.DetailsRendererNodeDetailsJSON}
 */
function targetToTableNode(target) {
  return {
    type: 'node',
    snippet: target.snippet,
    path: target.path,
    selector: target.selector,
  };
}

class TapTargets extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'tap-targets',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      requiredArtifacts: ['MetaElements', 'TapTargets'],
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @return {LH.Audit.Product}
   */
  static audit(artifacts) {
    const hasViewportSet = ViewportAudit.audit(artifacts).rawValue;
    if (!hasViewportSet) {
      return {
        rawValue: false,
        explanation: str_(UIStrings.explanationViewportMetaNotOptimized),
      };
    }

    const tooSmallTargets = getTooSmallTargets(artifacts.TapTargets);
    const overlapFailures = getAllOverlapFailures(tooSmallTargets, artifacts.TapTargets);
    const overlapFailuresForDisplay = mergeSymmetricFailures(overlapFailures);
    const tableItems = getTableItems(overlapFailuresForDisplay);

    const headings = [
      {key: 'tapTarget', itemType: 'node', text: str_(UIStrings.tapTargetHeader)},
      {key: 'size', itemType: 'text', text: str_(UIStrings.sizeHeader)},
      {key: 'overlappingTarget', itemType: 'node', text: str_(UIStrings.overlappingTargetHeader)},
    ];

    const details = Audit.makeTableDetails(headings, tableItems);

    const tapTargetCount = artifacts.TapTargets.length;
    const failingTapTargetCount = new Set(overlapFailures.map(f => f.tapTarget)).size;
    const passingTapTargetCount = tapTargetCount - failingTapTargetCount;

    const score = tapTargetCount > 0 ? passingTapTargetCount / tapTargetCount : 1;
    const displayValue = str_(UIStrings.displayValue, {decimalProportion: score});

    return {
      rawValue: tableItems.length === 0,
      score,
      details,
      displayValue,
    };
  }
}

TapTargets.FINGER_SIZE_PX = FINGER_SIZE_PX;

module.exports = TapTargets;


/** @typedef {{
  overlapScoreRatio: number;
  tapTargetScore: number;
  overlappingTargetScore: number;
}} ClientRectOverlapFailure */

/** @typedef {{
  overlapScoreRatio: number;
  tapTargetScore: number;
  overlappingTargetScore: number;
  tapTarget: LH.Artifacts.TapTarget;
  overlappingTarget: LH.Artifacts.TapTarget;
}} TapTargetOverlapFailure */

/** @typedef {{
  tapTarget: LH.Audit.DetailsRendererNodeDetailsJSON;
  overlappingTarget: LH.Audit.DetailsRendererNodeDetailsJSON;
  size: string;
  overlapScoreRatio: number;
  height: number;
  width: number;
  tapTargetScore: number;
  overlappingTargetScore: number;
}} TapTargetTableItem */
