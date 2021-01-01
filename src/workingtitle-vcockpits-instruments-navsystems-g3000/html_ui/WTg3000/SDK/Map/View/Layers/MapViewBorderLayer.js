/**
 * Borders and labels for countries and states/provinces.
 */
class WT_MapViewBorderLayer extends WT_MapViewMultiLayer {
    /**
     * @param {WT_MapViewTextLabelManager} labelManager - the label manager to use for labels.
     * @param {String} [className] - the name of the class to add to the new layer's top-level HTML element's class list.
     * @param {String} [configName] - the name of the property in the map view's config file to be associated with the new layer.
     */
    constructor(labelManager, className = WT_MapViewBorderLayer.CLASS_DEFAULT, configName = WT_MapViewBorderLayer.CONFIG_NAME_DEFAULT) {
        super(className, configName);

        this._labelManager = labelManager;

        this._borderLayer = new WT_MapViewPersistentCanvas(WT_MapViewBorderLayer.OVERDRAW_FACTOR);
        this.addSubLayer(this._borderLayer);

        this._renderQueue = new WT_MapViewRenderQueue();
        this._bufferedContext = new WT_MapViewBufferedCanvasContext(this._borderLayer.buffer.context, this._renderQueue);
        this._renderer = {
            canRender: this._canContinueRender.bind(this),
            render: this._resolveDrawCall.bind(this),
            onPaused: this._updateDrawBorders.bind(this),
            onFinished: this._finishDrawBorders.bind(this),
            onAborted: this._abortDrawBorders.bind(this)
        };

        this._labelCache = new WT_MapViewBorderLabelCache();
        this._labelsToShow = new Set();

        this._loadBorderJSON(WT_MapViewBorderLayer.DATA_FILE_PATH);

        this._optsManager = new WT_OptionsManager(this, WT_MapViewBorderLayer.OPTIONS_DEF);

        this._isReady = false;
        this._lastShowStateBorders = false;
        this._drawUnfinishedBorders = false;
        this._redrawTimer = 0;

        this._lastTime = 0;
    }

    /**
     * @readonly
     * @property {Boolean} isReady - whether this layer has finished loading data and is ready to render.
     * @type {Boolean}
     */
    get isReady() {
        return this._isReady;
    }

    _loadBorderJSON(path) {
        let request = new XMLHttpRequest();
        request.overrideMimeType("application/json");

        request.addEventListener("load",
            (function() {
                this._loadData(request.responseText);
            }).bind(this)
        );
        request.open("GET", path);
        request.send();
    }

    _filterScaleRank(threshold, feature) {
        return feature.properties.scalerank <= threshold;
    }

    _createFeatureInfo(feature) {
        let bounds = d3.geoBounds(feature);
        // avoid +90 or -90 latitude
        bounds[0][1] = Math.min(89.9, Math.max(-89.9, bounds[0][1]));
        bounds[1][1] = Math.min(89.9, Math.max(-89.9, bounds[1][1]));

        return {
            feature: feature,
            geoBounds: bounds,
            geoCentroid: d3.geoCentroid(feature),
            geoArea: d3.geoArea(feature)
        };
    }

    _processFeaturesObject(topology, object, array, simplifyThreshold, scaleRankThreshold) {
        array.push(...topojson.feature(topojson.simplify(topology, simplifyThreshold), object).features.filter(
            this._filterScaleRank.bind(this, scaleRankThreshold)
        ).map(
            this._createFeatureInfo.bind(this)
        ));
    }

    _processBorders(topology) {
        this._admin0Borders = [];
        this._admin1Borders = [];
        for (let i = 0; i < WT_MapViewBorderLayer.LOD_SIMPLIFY_THRESHOLDS.length; i++) {
            this._admin0Borders.push([]);
            this._admin1Borders.push([]);
            this._processFeaturesObject(topology, topology.objects.admin0Boundaries, this._admin0Borders[i], WT_MapViewBorderLayer.LOD_SIMPLIFY_THRESHOLDS[i], 2);
            this._processFeaturesObject(topology, topology.objects.admin0MapUnitBoundaries, this._admin0Borders[i], WT_MapViewBorderLayer.LOD_SIMPLIFY_THRESHOLDS[i], Infinity);
            this._processFeaturesObject(topology, topology.objects.admin1Boundaries, this._admin1Borders[i], WT_MapViewBorderLayer.LOD_SIMPLIFY_THRESHOLDS[i], 2);
        }
    }

    _processPolygons(topology) {
        this._admin0Polygons = [];
        this._processFeaturesObject(topology, topology.objects.admin0Polygons, this._admin0Polygons, Number.MIN_VALUE, Infinity);

        this._admin1Polygons = [];
        this._processFeaturesObject(topology, topology.objects.admin1Polygons, this._admin1Polygons, Number.MIN_VALUE, 2);
    }

    _loadData(data) {
        let topology = JSON.parse(data);
        let presimplified = topojson.presimplify(topology, topojson.sphericalTriangleArea);
        this._processBorders(presimplified);
        this._processPolygons(presimplified);
        this._isReady = true;
    }

    /**
     * @param {WT_MapViewState} state
     */
    isVisible(state) {
        return state.model.borders.show;
    }

    /**
     * @param {WT_MapViewState} state
     */
    onConfigLoaded(state) {
        for (let property of WT_MapViewBorderLayer.CONFIG_PROPERTIES) {
            this._setPropertyFromConfig(property);
        }
    }

    _shouldShowStateBorders(state) {
        return state.model.borders.stateBorderShow && state.model.range.compare(state.model.borders.stateBorderRange) <= 0;
    }

    _cullFeatureByBounds(renderer, bounds, temp, featureInfo) {
        let min = renderer.project(featureInfo.geoBounds[0], temp[0]);
        let max = renderer.project(featureInfo.geoBounds[1], temp[1]);
        let left = Math.min(min[0], max[0]);
        let right = Math.max(min[0], max[0]);
        let top = Math.min(min[1], max[1]);
        let bottom = Math.max(min[1], max[1]);

        return left <= bounds[1].x &&
               right >= bounds[0].x &&
               top <= bounds[1].y &&
               bottom >= bounds[0].y;
    }

    /**
     * Selects an LOD level for a given map view window resolution.
     * @param {WT_NumberUnit} viewResolution - the resolution of the map view window, expressed as the geographic distance covered by one pixel.
     * @returns {Number} an LOD level.
     */
    _selectLOD(viewResolution) {
        for (let i = WT_MapViewBorderLayer.LOD_RESOLUTION_THRESHOLDS.length - 1; i >= 0; i--) {
            if (viewResolution.compare(WT_MapViewBorderLayer.LOD_RESOLUTION_THRESHOLDS[i]) >= 0) {
                return i;
            }
        }
        return 0;
    }

    _enqueueFeaturesToDraw(state, features, lod) {
        let clipExtent = this._borderLayer.buffer.projectionRenderer.viewClipExtent;
        let temp = [[0, 0], [0, 0]];
        for (let feature of features[lod].filter(this._cullFeatureByBounds.bind(this, this._borderLayer.buffer.projectionRenderer, clipExtent, temp))) {
            this._borderLayer.buffer.projectionRenderer.renderCanvas(feature.feature, this._bufferedContext);
        }
    }

    _canContinueRender(current, renderCount, renderTime) {
        return renderTime < WT_MapViewBorderLayer.DRAW_TIME_BUDGET;
    }

    _resolveDrawCall(current, state) {
        current();
    }

    _startDrawBorders(state, showStateBorders) {
        this._borderLayer.resetBuffer(state);

        let lod = this._selectLOD(state.projection.viewResolution);
        this._renderQueue.clear();
        this._enqueueFeaturesToDraw(state, this._admin0Borders, lod);
        if (showStateBorders) {
            this._enqueueFeaturesToDraw(state, this._admin1Borders, lod);
        }

        this._borderLayer.buffer.context.beginPath();
        this._renderQueue.start(this._renderer, state);
    }

    _continueDrawBorders(state) {
        this._renderQueue.resume(state);
    }

    _applyStrokeToBuffer(lineWidth, strokeColor) {
        this._borderLayer.buffer.context.lineWidth = lineWidth;
        this._borderLayer.buffer.context.strokeStyle = strokeColor;
        this._borderLayer.buffer.context.stroke();
    }

    _drawBordersToDisplay(state) {
        if (this.outlineWidth > 0) {
            this._applyStrokeToBuffer((this.strokeWidth + 2 * this.outlineWidth) * state.dpiScale, this.outlineColor);
        }
        this._applyStrokeToBuffer(this.strokeWidth * state.dpiScale, this.strokeColor);
        this._borderLayer.redrawDisplay(state);
    }

    _updateDrawBorders(state) {
        if (this._drawUnfinishedBorders) {
            this._drawBordersToDisplay(state);
        }
    }

    _finishDrawBorders(state) {
        this._drawBordersToDisplay(state);
        this._updateLabels(state);
        this._drawUnfinishedBorders = false;
    }

    _abortDrawBorders() {
    }

    _clearLabels() {
        for (let label of this._labelsToShow.values()) {
            this._labelManager.remove(label);
        }
        this._labelsToShow.clear();
    }

    _cullLabelsToShow(state, tempArrays, tempVector, featureInfo) {
        if (!this._cullFeatureByBounds(this._borderLayer.buffer.projectionRenderer, this._borderLayer.buffer.projectionRenderer.viewClipExtent, tempArrays, featureInfo)) {
            return false;
        }

        let viewCentroid = WT_MapProjection.xyProjectionToView(this._borderLayer.buffer.projectionRenderer.project(featureInfo.geoCentroid, tempArrays[0]), tempVector);
        let sec = 1 / Math.cos(featureInfo.geoCentroid[1] * Avionics.Utils.DEG2RAD);
        let area = featureInfo.geoArea * state.projection.scale * state.projection.scale * sec * sec; // estimate based on mercator projection
        let viewArea = state.projection.viewWidth * state.projection.viewHeight;
        return this._borderLayer.buffer.projectionRenderer.isInView(viewCentroid, -0.05) &&
               area < viewArea * WT_MapViewBorderLayer.LABEL_FEATURE_AREA_MAX &&
               area > viewArea * WT_MapViewBorderLayer.LABEL_FEATURE_AREA_MIN;
    }

    _setLabelStyles(label, fontSize, fontColor, outlineWidth, outlineColor) {
        label.fontSize = fontSize;
        label.fontColor = fontColor;
        label.fontOutlineWidth = outlineWidth;
        label.fontOutlineColor = outlineColor;
    }

    /**
     *
     * @param {Iterable<WT_MapViewBorderLabel>} newLabelsToShow
     */
    _updateLabelsToShow(newLabelsToShow) {
        this._clearLabels();
        for (let label of newLabelsToShow) {
            if (label.featureClass === WT_MapViewBorderLabel.Class.ADMIN0) {
                this._setLabelStyles(label, this.countryFontSize, this.countryFontColor, this.countryFontOutlineWidth, this.countryFontOutlineColor);
            } else {
                this._setLabelStyles(label, this.stateFontSize, this.stateFontColor, this.stateFontOutlineWidth, this.stateFontOutlineColor);
            }
            this._labelsToShow.add(label);
            this._labelManager.add(label);
        }
    }

    /**
     *
     * @param {WT_MapViewState} state
     */
    _updateLabels(state) {
        let tempArrays = [[0, 0], [0, 0]];
        let tempVector = new WT_GVector2(0, 0);
        let toShow = this._admin0Polygons.filter(this._cullLabelsToShow.bind(this, state, tempArrays, tempVector));
        if (this._shouldShowStateBorders(state)) {
            toShow = toShow.concat(this._admin1Polygons.filter(this._cullLabelsToShow.bind(this, state, tempArrays, tempVector)));
        }
        this._updateLabelsToShow(toShow.map(featureInfo => this._labelCache.getLabel(featureInfo, this.countryLabelPriority, this.stateLabelPriority)));
    }

    /**
     *
     * @param {WT_MapViewState} state
     */
    _handleRedraw(state) {
        let transform = this._borderLayer.display.transform;
        let offsetXAbs = Math.abs(transform.offset.x);
        let offsetYAbs = Math.abs(transform.offset.y);

        let shouldShowStateBorders = this._shouldShowStateBorders(state);

        let isDisplayInvalid = this._borderLayer.display.isInvalid;
        let shouldInvalidate = isDisplayInvalid ||
                               (!shouldShowStateBorders && this._lastShowStateBorders);

        let shouldRedraw = shouldInvalidate ||
                           (shouldShowStateBorders != this._lastShowStateBorders) ||
                           (offsetXAbs > transform.margin * 0.9 || offsetYAbs > transform.margin * 0.9);

        this._lastShowStateBorders = shouldShowStateBorders;

        if (shouldInvalidate) {
            this._borderLayer.redrawDisplay(state, false);
            this._clearLabels();
            this._drawUnfinishedBorders = true;
        }

        if (isDisplayInvalid) {
            // start timer
            this._redrawTimer = WT_MapViewBorderLayer.REDRAW_DELAY;
            return;
        }
        if (this._redrawTimer > 0) {
            this._redrawTimer -= state.currentTime - this._lastTime;
            if (this._redrawTimer <= 0) {
                shouldRedraw = true;
            } else {
                return;
            }
        }

        if (shouldRedraw) {
            this._startDrawBorders(state, shouldShowStateBorders);
        } else if (this._renderQueue.isBusy) {
            this._continueDrawBorders(state);
        }
    }

    /**
     * @param {WT_MapViewState} state
     */
    onUpdate(state) {
        super.onUpdate(state);

        if (!this.isReady) {
            return;
        }

        this._borderLayer.update(state);
        this._handleRedraw(state);
        this._lastTime = state.currentTime;
    }
}
WT_MapViewBorderLayer.CLASS_DEFAULT = "borderLayer";
WT_MapViewBorderLayer.CONFIG_NAME_DEFAULT = "border";
WT_MapViewBorderLayer.DATA_FILE_PATH = "/WTg3000/SDK/Assets/Data/borders.json";
WT_MapViewBorderLayer.LOD_SIMPLIFY_THRESHOLDS = [
    Number.MIN_VALUE,
    0.00000003,
    0.0000003,
    0.000003,
    0.00003
];
WT_MapViewBorderLayer.LOD_RESOLUTION_THRESHOLDS = [
    WT_Unit.NMILE.createNumber(0),
    WT_Unit.NMILE.createNumber(0.06),
    WT_Unit.NMILE.createNumber(0.3),
    WT_Unit.NMILE.createNumber(0.9),
    WT_Unit.NMILE.createNumber(3)
];
WT_MapViewBorderLayer.OVERDRAW_FACTOR = 1.66421356237;
WT_MapViewBorderLayer.REDRAW_DELAY = 500; // ms
WT_MapViewBorderLayer.DRAW_TIME_BUDGET = 2; // ms
WT_MapViewBorderLayer.LABEL_FEATURE_AREA_MAX = 0.75; // fraction of view area
WT_MapViewBorderLayer.LABEL_FEATURE_AREA_MIN = 0.0025; // fraction of view area
WT_MapViewBorderLayer.OPTIONS_DEF = {
    strokeWidth: {default: 2, auto: true},
    strokeColor: {default: "white", auto: true},
    outlineWidth: {default: 0, auto: true},
    outlineColor: {default: "black", auto: true},

    countryLabelPriority: {default: 60, auto: true},
    stateLabelPriority: {default: 40, auto: true},

    countryFontSize: {default: 25, auto: true},
    countryFontColor: {default: "white", auto: true},
    countryFontOutlineWidth: {default: 6, auto: true},
    countryFontOutlineColor: {default: "black", auto: true},

    stateFontSize: {default: 20, auto: true},
    stateFontColor: {default: "white", auto: true},
    stateFontOutlineWidth: {default: 6, auto: true},
    stateFontOutlineColor: {default: "black", auto: true}
};
WT_MapViewBorderLayer.CONFIG_PROPERTIES = [
    "strokeWidth",
    "strokeColor",
    "outlineWidth",
    "outlineColor",
    "countryLabelPriority",
    "stateLabelPriority",
    "countryFontSize",
    "countryFontColor",
    "countryFontOutlineWidth",
    "countryFontOutlineColor",
    "stateFontSize",
    "stateFontColor",
    "stateFontOutlineWidth",
    "stateFontOutlineColor",
];

class WT_MapViewBorderLabel extends WT_MapViewSimpleTextLabel {
    constructor(featureInfo, featureClass, text, priority) {
        super(text, priority);
        this._feature = featureInfo.feature;
        this._featureClass = featureClass;
        this._geoPosition = WT_MapProjection.latLongProjectionToGame(featureInfo.geoCentroid);

        this._anchor.set(0.5, 0.5);
    }

    /**
     * @readonly
     * @property {Object} feature - this label's feature.
     * @type {Object}
     */
    get feature() {
        return this._feature;
    }

    /**
     * @readonly
     * @property {Number} featureClass - the class (admin0 or admin1) of this label's feature.
     * @type {Number}
     */
    get featureClass() {
        return this._featureClass;
    }

    /**
     * @param {WT_MapViewState} state
     */
    update(state) {
        state.projection.project(this._geoPosition, this._position);

        super.update(state);
    }

    static createFromFeature(featureInfo, admin0Priority, admin1Priority) {
        let text = featureInfo.feature.properties.name;
        let priority = 0;
        let featureClass;

        switch (featureInfo.feature.properties.featurecla) {
            case WT_MapViewBorderLabel.Class.ADMIN0:
                featureClass = WT_MapViewBorderLabel.Class.ADMIN0;
                priority = admin0Priority - featureInfo.feature.properties.labelrank;
                break;
            case WT_MapViewBorderLabel.Class.ADMIN1:
                featureClass = WT_MapViewBorderLabel.Class.ADMIN1;
                priority = admin1Priority - featureInfo.feature.properties.labelrank;
                break;
        }

        return new WT_MapViewBorderLabel(featureInfo, featureClass, text, priority);
    }
}
/**
 * @enum {Number}
 */
WT_MapViewBorderLabel.Class = {
    ADMIN0: "Admin-0 map subunit",
    ADMIN1: "Admin-1 scale rank"
}

class WT_MapViewBorderLabelCache {
    constructor() {
        this._cache = new Map();
    }

    /**
     * Gets a label for a feature. If one cannot be found in the cache, a new label is added to the cache and
     * returned.
     * @param {WT_Waypoint} featureInfo - the GeoJSON featureInfo object for the feature.
     * @param {Number} admin0Priority - the priority of admin0 feature labels.
     * @param {Number} admin1Priority - the priority of admin1 feature labels.
     * @returns {WT_MapViewBorderLabel} a feature label.
     */
    getLabel(featureInfo, admin0Priority, admin1Priority) {
        let existing = this._cache.get(featureInfo);
        if (!existing) {
            existing = WT_MapViewBorderLabel.createFromFeature(featureInfo, admin0Priority, admin1Priority);
            this._cache.set(featureInfo, existing);
        }
        return existing;
    }
}