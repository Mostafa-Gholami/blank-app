"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import Card = formattingSettings.SimpleCard;
import Model = formattingSettings.Model;
import Slice = formattingSettings.Slice;

const colour = (name: string, displayName: string, value: string) =>
    new formattingSettings.ColorPicker({ name, displayName, value: { value } });

const toggle = (name: string, displayName: string, value: boolean) =>
    new formattingSettings.ToggleSwitch({ name, displayName, value });

const num = (name: string, displayName: string, value: number, min: number, max: number) =>
    new formattingSettings.NumUpDown({
        name, displayName, value,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: min },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: max }
        }
    });

const percent = (name: string, displayName: string, value: number) =>
    new formattingSettings.Slider({
        name, displayName, value,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 0 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 100 },
            unitSymbol: "%"
        }
    });

const text = (name: string, displayName: string, value: string, placeholder: string) =>
    new formattingSettings.TextInput({ name, displayName, value, placeholder });

export const BASE_STYLE_ITEMS: powerbi.IEnumMember[] = [
    { value: "blank", displayName: "Blank (offline, no roads)" },
    { value: "positron", displayName: "Light – OpenFreeMap Positron" },
    { value: "dark", displayName: "Dark – OpenFreeMap Dark" },
    { value: "liberty", displayName: "Detailed – OpenFreeMap Liberty" },
    { value: "custom", displayName: "Custom style URL" }
];

const LEGEND_POSITIONS: powerbi.IEnumMember[] = [
    { value: "top-left", displayName: "Top left" },
    { value: "top-right", displayName: "Top right" },
    { value: "bottom-left", displayName: "Bottom left" },
    { value: "bottom-right", displayName: "Bottom right" }
];

class BaseMapCard extends Card {
    style = new formattingSettings.ItemDropdown({ name: "style", displayName: "Base map", items: BASE_STYLE_ITEMS, value: BASE_STYLE_ITEMS[0] });
    customUrl = text("customUrl", "Custom style URL", "", "https://…/style.json (domain must be in capabilities WebAccess)");
    hideRoads = toggle("hideRoads", "Hide roads", true);
    hideLabels = toggle("hideLabels", "Hide base map labels", true);
    background = colour("background", "Background", "#F4F4F2");

    name = "baseMap";
    displayName = "Base map";
    slices: Slice[] = [this.style, this.customUrl, this.hideRoads, this.hideLabels, this.background];
}

class ConstituencyCard extends Card {
    show = toggle("show", "Show constituencies", true);
    nameProperty = text("nameProperty", "Name property", "PCON24NM", "PCON24NM");
    useGeoJsonColours = toggle("useGeoJsonColours", "Use party colours from GeoJSON", true);
    defaultColour = colour("defaultColour", "Fallback colour", "#9AA0A6");
    fillOpacity = percent("fillOpacity", "Fill opacity", 25);
    strokeWidth = num("strokeWidth", "Boundary width", 1.2, 0, 10);
    strokeOpacity = percent("strokeOpacity", "Boundary opacity", 100);
    tooltipProperties = text("tooltipProperties", "Extra tooltip properties", "Party, MP_Name", "Comma-separated GeoJSON property names");

    topLevelSlice = this.show;
    name = "constituencies";
    displayName = "Constituencies";
    slices: Slice[] = [this.nameProperty, this.useGeoJsonColours, this.defaultColour, this.fillOpacity,
        this.strokeWidth, this.strokeOpacity, this.tooltipProperties];
}

class ConstituencyLabelCard extends Card {
    show = toggle("show", "Show labels", true);
    fontSize = num("fontSize", "Text size", 11, 6, 32);
    colour = colour("colour", "Text colour", "#2B2B2B");
    haloColour = colour("haloColour", "Halo colour", "#FFFFFF");
    minZoom = num("minZoom", "Show from zoom level", 7, 0, 22);

    topLevelSlice = this.show;
    name = "constituencyLabels";
    displayName = "Constituency labels";
    slices: Slice[] = [this.fontSize, this.colour, this.haloColour, this.minZoom];
}

class RailLineCard extends Card {
    show = toggle("show", "Show rail lines", true);
    mainlineColour = colour("mainlineColour", "Mainline colour", "#333333");
    mainlineWidth = num("mainlineWidth", "Mainline width", 3, 0.5, 20);
    branchColour = colour("branchColour", "Branch colour", "#8A8F98");
    branchWidth = num("branchWidth", "Branch width", 1.4, 0.5, 20);
    dashBranches = toggle("dashBranches", "Dashed branch lines", false);

    topLevelSlice = this.show;
    name = "railLines";
    displayName = "Rail lines";
    slices: Slice[] = [this.mainlineColour, this.mainlineWidth, this.branchColour, this.branchWidth, this.dashBranches];
}

class StationCard extends Card {
    show = toggle("show", "Show stations", true);
    radius = num("radius", "Bubble size", 5, 1, 40);
    opacity = percent("opacity", "Opacity", 90);
    defaultColour = colour("defaultColour", "Default colour", "#1F6FB2");
    strokeColour = colour("strokeColour", "Outline colour", "#FFFFFF");
    strokeWidth = num("strokeWidth", "Outline width", 1, 0, 10);
    colourOverrides = text("colourOverrides", "SFO colour overrides", "", "Northern=#262262; Network Rail=#F15A29");
    onlyInRadius = toggle("onlyInRadius", "Hide stations outside radius", true);
    showLabels = toggle("showLabels", "Show station names", false);
    labelMinZoom = num("labelMinZoom", "Names from zoom level", 10, 0, 22);

    topLevelSlice = this.show;
    name = "stations";
    displayName = "Stations";
    slices: Slice[] = [this.radius, this.opacity, this.defaultColour, this.strokeColour, this.strokeWidth,
        this.colourOverrides, this.onlyInRadius, this.showLabels, this.labelMinZoom];
}

class LegendCard extends Card {
    show = toggle("show", "Show legend", true);
    position = new formattingSettings.ItemDropdown({ name: "position", displayName: "Position", items: LEGEND_POSITIONS, value: LEGEND_POSITIONS[0] });

    topLevelSlice = this.show;
    name = "legend";
    displayName = "Legend";
    slices: Slice[] = [this.position];
}

class ZoomCard extends Card {
    autoZoom = toggle("autoZoom", "Zoom to filtered data", true);
    padding = num("padding", "Padding (px)", 40, 0, 300);
    maxZoom = num("maxZoom", "Maximum zoom", 13, 1, 22);

    name = "zoom";
    displayName = "Zoom";
    slices: Slice[] = [this.autoZoom, this.padding, this.maxZoom];
}

class RadiusCard extends Card {
    show = toggle("show", "Show search radius", true);
    colour = colour("colour", "Colour", "#E4572E");
    fillOpacity = percent("fillOpacity", "Fill opacity", 8);

    topLevelSlice = this.show;
    name = "radiusCircle";
    displayName = "Search radius";
    slices: Slice[] = [this.colour, this.fillOpacity];
}

export class VisualFormattingSettingsModel extends Model {
    baseMap = new BaseMapCard();
    constituencies = new ConstituencyCard();
    constituencyLabels = new ConstituencyLabelCard();
    railLines = new RailLineCard();
    stations = new StationCard();
    legend = new LegendCard();
    zoom = new ZoomCard();
    radiusCircle = new RadiusCard();

    cards = [this.baseMap, this.constituencies, this.constituencyLabels, this.railLines,
        this.stations, this.legend, this.zoom, this.radiusCircle];
}
